/**
 * 2062 - TTRPG campaign clock & daily bulletin Discord bot.
 *
 * Single-file Cloudflare Worker:
 *   - fetch()     handles Discord HTTP interactions (slash commands) + the /register route.
 *   - scheduled() is a per-minute Cron Trigger that posts the daily bulletin.
 *   - Cloudflare D1 (SQLite) holds all persistent state; tables self-create on first use.
 *
 * Everything tunable lives in CONFIG below so the rest of the file never hardcodes a value.
 */

import { verifyKey } from "discord-interactions";

const CONFIG = {
  botName: "2062",
  embedColor: 0x00e5ff,
  defaults: {
    startTime: "2062-01-01 08:00", // in-universe clock seed
    advanceRate: "1d", // in-universe time added per daily tick
    postTime: "09:00", // real-world daily post time (HH:MM)
    postTz: "UTC", // IANA timezone the postTime is interpreted in
    adminRoles: ["GameMaster", "dev"], // role names allowed to run admin commands
  },
} as const;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  REGISTER_SECRET: string;
  DISCORD_GUILD_ID?: string;
}

interface Announcement {
  id: number;
  at_time: number;
  message: string;
  created_at: number;
}

interface State {
  currentTime: number;
  paused: boolean;
  postTime: string;
  postTz: string;
  advanceRate: number; // ms
  channelId: string;
  adminRoles: string[];
  lastPostDate: string;
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, "0");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Time helpers  (in-universe time is a timezone-free UTC epoch)
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (or with a 'T') into epoch ms, or null. */
function parseDateTime(input: string): number | null {
  const m = String(input).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], hh = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, hh, mi);
  const dt = new Date(ms);
  // Reject rollovers like 2062-02-31.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

/** Parse a duration like "3d", "6h", "90m", "1d6h", "2w" into ms, or null. */
function parseDuration(input: string): number | null {
  const cleaned = String(input).trim().toLowerCase();
  if (!/^(\d+\s*[wdhm]\s*)+$/.test(cleaned)) return null;
  const re = /(\d+)\s*([wdhm])/g;
  let total = 0, m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const minutes = unit === "w" ? 7 * 24 * 60 : unit === "d" ? 24 * 60 : unit === "h" ? 60 : 1;
    total += n * minutes * 60000;
  }
  return total > 0 ? total : null;
}

/** ms -> "1w 2d 6h 30m" */
function humanDuration(ms: number): string {
  let mins = Math.floor(ms / 60000);
  const w = Math.floor(mins / (7 * 24 * 60)); mins -= w * 7 * 24 * 60;
  const d = Math.floor(mins / (24 * 60)); mins -= d * 24 * 60;
  const h = Math.floor(mins / 60); const m = mins % 60;
  const parts: string[] = [];
  if (w) parts.push(`${w}w`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ") || "0m";
}

const isoDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
};
const isoTime = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};

/** "08:00" */
const formatTime = (ms: number) => isoTime(ms);

/** "Monday, 9 January 2062" */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Monday, 9 January 2062 at 08:00" */
const formatDateTime = (ms: number) => `${formatDate(ms)} at ${formatTime(ms)}`;

/** "9 January 2062", or "9 January 2062 at 14:30" when a time-of-day is present. */
function formatAnnDate(ms: number): string {
  const d = new Date(ms);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${base} at ${isoTime(ms)}` : base;
}

/** Midnight UTC of the in-universe day containing `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Current wall-clock date/time in an IANA timezone. Returns { date: "YYYY-MM-DD", time: "HH:MM" }. */
function tzParts(ms: number, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Some runtimes emit "24" for midnight with hour12:false.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Real epoch (ms) of the next daily post moment, given current state. */
function nextPostAt(now: number, s: State): number {
  const { date, time } = tzParts(now, s.postTz);
  const [Y, Mo, D] = date.split("-").map(Number);
  const [H, Mi] = time.split(":").map(Number);
  const offsetMs = Date.UTC(Y, Mo - 1, D, H, Mi) - now; // how far ahead of UTC this tz is
  const [ph, pm] = s.postTime.split(":").map(Number);
  let next = Date.UTC(Y, Mo - 1, D, ph, pm) - offsetMs; // today's post moment in real UTC
  if (s.lastPostDate === date) {
    next += 24 * 60 * 60000; // already posted today, so next is tomorrow
  } else if (next <= now) {
    next = now; // post time already passed today and not yet posted -> due now
  }
  return next;
}

// ---------------------------------------------------------------------------
// Persistence (Cloudflare D1)
// ---------------------------------------------------------------------------

let schemaReady = false;

async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_time INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ann_time ON announcements(at_time)`),
  ]);

  const d = CONFIG.defaults;
  const seed: [string, string][] = [
    ["current_time", String(parseDateTime(d.startTime))],
    ["paused", "0"],
    ["post_time", d.postTime],
    ["post_tz", d.postTz],
    ["advance_rate", String(parseDuration(d.advanceRate))],
    ["channel_id", ""],
    ["admin_roles", JSON.stringify(d.adminRoles)],
    ["last_post_date", ""],
  ];
  await env.DB.batch(
    seed.map(([k, v]) =>
      env.DB.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)`).bind(k, v),
    ),
  );
  schemaReady = true;
}

async function loadState(env: Env): Promise<State> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM config`).all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const d = CONFIG.defaults;
  return {
    currentTime: Number(m.get("current_time") ?? parseDateTime(d.startTime)),
    paused: (m.get("paused") ?? "0") === "1",
    postTime: m.get("post_time") ?? d.postTime,
    postTz: m.get("post_tz") ?? d.postTz,
    advanceRate: Number(m.get("advance_rate") ?? parseDuration(d.advanceRate)),
    channelId: m.get("channel_id") ?? "",
    adminRoles: JSON.parse(m.get("admin_roles") ?? JSON.stringify(d.adminRoles)),
    lastPostDate: m.get("last_post_date") ?? "",
  };
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB
    .prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

/** Announcements reached in the half-open window (oldMs, newMs], chronological. */
async function windowAnnouncements(env: Env, oldMs: number, newMs: number): Promise<Announcement[]> {
  const { results } = await env.DB
    .prepare(`SELECT * FROM announcements WHERE at_time > ? AND at_time <= ? ORDER BY at_time ASC, id ASC`)
    .bind(oldMs, newMs)
    .all<Announcement>();
  return results;
}

// ---------------------------------------------------------------------------
// Discord REST
// ---------------------------------------------------------------------------

const API = "https://discord.com/api/v10";

async function discord(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function postMessage(env: Env, channelId: string, payload: unknown): Promise<boolean> {
  const res = await discord(env, "POST", `/channels/${channelId}/messages`, payload);
  if (!res.ok) console.error("postMessage failed", res.status, await res.text());
  return res.ok;
}

async function getGuildRoles(env: Env, guildId: string): Promise<{ id: string; name: string }[]> {
  const res = await discord(env, "GET", `/guilds/${guildId}/roles`);
  if (!res.ok) return [];
  return (await res.json()) as { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Bulletin embed
// ---------------------------------------------------------------------------

function announcementLines(ms: number, anns: Announcement[]): string {
  return anns
    .map((a) =>
      isoDate(a.at_time) === isoDate(ms)
        ? `- ${a.message}` // same day as the heading; the date would be redundant
        : `- ${formatAnnDate(a.at_time)}: ${a.message}`,
    )
    .join("\n");
}

function buildBulletin(
  ms: number,
  anns: Announcement[],
  opts: { intro?: string; noneText?: string; paused?: boolean } = {},
): object {
  const parts: string[] = [];
  if (opts.intro) parts.push(opts.intro);
  parts.push(`The time is ${formatTime(ms)}.`);
  parts.push(anns.length ? announcementLines(ms, anns) : opts.noneText ?? "There are no announcements today.");
  return {
    title: formatDate(ms),
    description: parts.join("\n\n"),
    color: CONFIG.embedColor,
    footer: { text: `${CONFIG.botName}${opts.paused ? " (clock paused)" : ""}` },
  };
}

// ---------------------------------------------------------------------------
// Interaction response helpers
// ---------------------------------------------------------------------------

const EPHEMERAL = 1 << 6; // 64

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

const reply = (content: string, ephemeral = false) =>
  json({ type: 4, data: { content, flags: ephemeral ? EPHEMERAL : 0 } });

const replyEmbed = (embed: object, ephemeral = false) =>
  json({ type: 4, data: { embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 } });

interface Interaction {
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { permissions?: string; roles?: string[]; user?: { id: string } };
  data: {
    name?: string;
    options?: { name: string; value: string | number }[];
    custom_id?: string;
    components?: { components: { custom_id: string; value: string }[] }[];
  };
}

function opt(interaction: Interaction, name: string): string | number | undefined {
  return interaction.data.options?.find((o) => o.name === name)?.value;
}

async function isAuthorized(env: Env, interaction: Interaction, adminRoles: string[]): Promise<boolean> {
  const member = interaction.member;
  const guildId = interaction.guild_id;
  if (!member || !guildId) return false; // guild-only
  // Guild administrators always pass.
  if (BigInt(member.permissions ?? "0") & 0x8n) return true;
  const wanted = new Set(adminRoles.map((r) => r.toLowerCase()));
  const roles = await getGuildRoles(env, guildId);
  const allowed = new Set(roles.filter((r) => wanted.has(r.name.toLowerCase())).map((r) => r.id));
  return (member.roles ?? []).some((id) => allowed.has(id));
}

// Commands anyone may use; everything else is role-gated.
const PUBLIC_COMMANDS = ["today", "help", "time", "attack"];

/** A popup with a multi-line paragraph box, so DM bodies can contain newlines. */
function openMsgModal(userId: string): Response {
  return json({
    type: 9, // MODAL
    data: {
      custom_id: `msg:${userId}`,
      title: "Send a message",
      components: [
        {
          type: 1,
          components: [
            { type: 4, custom_id: "body", label: "Message", style: 2, required: true, max_length: 2000 },
          ],
        },
      ],
    },
  });
}

/** Open a DM channel with a user and send them `content`. */
async function sendDm(env: Env, userId: string, content: string): Promise<Response> {
  const dmRes = await discord(env, "POST", "/users/@me/channels", { recipient_id: userId });
  if (!dmRes.ok) return reply(`Could not open a DM with <@${userId}>.`, true);
  const dm = (await dmRes.json()) as { id: string };
  const sent = await postMessage(env, dm.id, { content });
  return reply(
    sent
      ? `Message sent to <@${userId}>.`
      : `Could not message <@${userId}>. They may have DMs from server members turned off.`,
    true,
  );
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleCommand(interaction: Interaction, env: Env): Promise<Response> {
  const name = interaction.data.name ?? "";
  const s = await loadState(env);

  if (!PUBLIC_COMMANDS.includes(name)) {
    if (!(await isAuthorized(env, interaction, s.adminRoles))) {
      return reply(
        `You do not have permission to use /${name}. This command is limited to the following roles: ` +
          `${s.adminRoles.join(", ")}.`,
        true,
      );
    }
  }

  switch (name) {
    case "today": {
      const day = startOfDay(s.currentTime);
      const { results } = await env.DB
        .prepare(`SELECT * FROM announcements WHERE at_time >= ? AND at_time < ? ORDER BY at_time ASC, id ASC`)
        .bind(day, day + 24 * 60 * 60000)
        .all<Announcement>();
      return replyEmbed(
        buildBulletin(s.currentTime, results, {
          paused: s.paused,
          noneText: "There are no announcements scheduled for today.",
        }),
      );
    }

    case "help": {
      const g = (lines: string[]) => lines.join("\n");
      return replyEmbed({
        title: `${CONFIG.botName} command guide`,
        description:
          "Only /today, /time, /help, and /attack are open to everyone. Every other command requires an admin role.",
        color: CONFIG.embedColor,
        fields: [
          {
            name: "Setup",
            value: g([
              "/setchannel [channel] - choose where the daily bulletin is posted",
              "/setposttime <time> [timezone] - set the real-world time it posts each day",
              "/setrate <duration> - how much in-universe time passes per day",
              "/setroles <names> - which roles may run admin commands",
            ]),
            inline: false,
          },
          {
            name: "The clock",
            value: g([
              "/today - the current in-universe date and today's announcements",
              "/time - real-world status and countdown to the next post",
              "/settime <datetime> - set the in-universe date and time",
              "/skip <duration> - move the clock forward now and post a bulletin",
              "/pause - stop the clock from advancing on its own",
              "/resume - let the clock advance again",
            ]),
            inline: false,
          },
          {
            name: "Announcements",
            value: g([
              "/announce <message> [date] [time] - schedule an item (omit the date to post it next time)",
              "/queue - list scheduled announcements and their IDs",
              "/edit <id> [message] [date] [time] - change an announcement",
              "/delete <id> - remove an announcement",
              "/flush - clear announcements whose date has already passed",
            ]),
            inline: false,
          },
          {
            name: "Other",
            value: g([
              "/attack - work out cohesion damage and casualties from an attack",
              "/msg <user> - send a direct message to a member",
              "/config - show the current settings at a glance",
              "/help - show this guide",
            ]),
            inline: false,
          },
        ],
      }, true);
    }

    case "time": {
      const now = Date.now();
      const { date, time } = tzParts(now, s.postTz);
      const diff = nextPostAt(now, s) - now;
      const when = diff < 60000 ? "in under a minute" : `in ${humanDuration(diff)}`;
      return replyEmbed({
        title: `${CONFIG.botName} status`,
        description: s.channelId
          ? undefined
          : "No bulletin channel is set yet, so nothing will post automatically. Run /setchannel to fix this.",
        color: CONFIG.embedColor,
        fields: [
          { name: "Real-world time", value: `${date} ${time} (${s.postTz})`, inline: false },
          { name: "Posts daily at", value: `${s.postTime} (${s.postTz})`, inline: true },
          { name: "Next bulletin", value: s.channelId ? when : "not scheduled", inline: true },
          {
            name: "In-universe clock",
            value: `${formatDateTime(s.currentTime)}${s.paused ? " (paused)" : ""}`,
            inline: false,
          },
        ],
      }, true);
    }

    case "attack": {
      const assault = Number(opt(interaction, "assault_roll"));
      const weaponry = Number(opt(interaction, "weaponry"));
      const deflection = Number(opt(interaction, "deflection_roll"));
      const protection = Number(opt(interaction, "protection"));
      const cohesion = Number(opt(interaction, "cohesion"));
      const men = Math.trunc(Number(opt(interaction, "men")));

      const margin = assault - deflection;
      const multiplier = 1 + margin / 100;
      const damage = weaponry * multiplier;
      const newCohesion = Math.max(0, cohesion - damage);
      const lossPercent = (cohesion - newCohesion) / 100;
      const casualtyReduction = weaponry + protection > 0 ? protection / (weaponry + protection) : 0;
      const casualties = Math.max(0, Math.round(men * lossPercent * (1 - casualtyReduction)));
      const remaining = Math.max(0, men - casualties);

      const num = (n: number) => n.toLocaleString("en-US");
      const desc = [
        `Margin: ${Math.round(margin)}`,
        `Effectiveness: ${multiplier.toFixed(2)}x`,
        `Cohesion damage: ${damage.toFixed(1)}`,
        `Cohesion: ${cohesion.toFixed(1)} to ${newCohesion.toFixed(1)}`,
        `Cohesion lost: ${(lossPercent * 100).toFixed(1)}%`,
        `Casualty reduction: ${(casualtyReduction * 100).toFixed(0)}%`,
        `Casualties: ${num(casualties)}`,
        `Remaining men: ${num(remaining)}`,
      ].join("\n");
      return replyEmbed({ title: "Attack result", description: desc, color: CONFIG.embedColor });
    }

    case "announce": {
      const message = String(opt(interaction, "message"));
      const dateStr = opt(interaction, "date") as string | undefined;
      const timeStr = opt(interaction, "time") as string | undefined;

      let at: number;
      if (dateStr === undefined) {
        // No date given: schedule it just after the current clock so the next
        // advancement (daily post or /skip) sweeps it into the very next bulletin.
        at = s.currentTime + 1;
      } else {
        const parsed = parseDateTime(timeStr ? `${dateStr} ${timeStr}` : dateStr);
        if (parsed == null) {
          return reply("That date or time is not valid. Use YYYY-MM-DD for the date and HH:MM for the time.", true);
        }
        at = parsed;
      }

      const row = await env.DB
        .prepare(`INSERT INTO announcements (at_time, message, created_at) VALUES (?, ?, ?) RETURNING id`)
        .bind(at, message, Date.now())
        .first<{ id: number }>();
      return reply(
        dateStr === undefined
          ? `Saved announcement #${row!.id}. It will appear in the next bulletin.`
          : `Saved announcement #${row!.id}, scheduled for ${formatAnnDate(at)}.`,
        true,
      );
    }

    case "queue": {
      const from = startOfDay(s.currentTime);
      const { results } = await env.DB
        .prepare(`SELECT * FROM announcements WHERE at_time >= ? ORDER BY at_time ASC, id ASC`)
        .bind(from)
        .all<Announcement>();
      if (!results.length) return reply("There are no scheduled announcements.", true);
      const lines = results
        .map((a) => `#${a.id}, ${formatAnnDate(a.at_time)}\n${a.message}`)
        .join("\n\n");
      return replyEmbed({ title: "Scheduled announcements", description: lines, color: CONFIG.embedColor }, true);
    }

    case "edit": {
      const id = Number(opt(interaction, "id"));
      const message = opt(interaction, "message") as string | undefined;
      const dateStr = opt(interaction, "date") as string | undefined;
      const timeStr = opt(interaction, "time") as string | undefined;
      if (message === undefined && dateStr === undefined && timeStr === undefined) {
        return reply("Give at least one thing to change: a message, a date, or a time.", true);
      }
      const existing = await env.DB.prepare(`SELECT * FROM announcements WHERE id = ?`).bind(id).first<Announcement>();
      if (!existing) return reply(`There is no announcement with the ID #${id}.`, true);

      let at = existing.at_time;
      if (dateStr !== undefined || timeStr !== undefined) {
        const datePart = dateStr ?? isoDate(existing.at_time);
        const timePart = timeStr ?? isoTime(existing.at_time);
        const parsed = parseDateTime(`${datePart} ${timePart}`);
        if (parsed == null) return reply("That date or time is not valid.", true);
        at = parsed;
      }
      const newMessage = message ?? existing.message;
      await env.DB.prepare(`UPDATE announcements SET at_time = ?, message = ? WHERE id = ?`).bind(at, newMessage, id).run();
      return reply(`Updated announcement #${id}. It is now set for ${formatAnnDate(at)}.`, true);
    }

    case "delete": {
      const id = Number(opt(interaction, "id"));
      const res = await env.DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id).run();
      if (!res.meta.changes) return reply(`There is no announcement with the ID #${id}.`, true);
      return reply(`Deleted announcement #${id}.`, true);
    }

    case "pause": {
      await setState(env, "paused", "1");
      return reply(
        "The clock is now paused. The daily bulletin will still post, but the in-universe date will not move until you resume.",
        true,
      );
    }

    case "resume": {
      await setState(env, "paused", "0");
      return reply("The clock will now advance again on its daily schedule.", true);
    }

    case "settime": {
      const dt = parseDateTime(String(opt(interaction, "datetime")));
      if (dt == null) return reply("That datetime is not valid. Use YYYY-MM-DD or YYYY-MM-DD HH:MM.", true);
      await setState(env, "current_time", String(dt));
      return reply(`The in-universe clock is now set to ${formatDateTime(dt)}.`, true);
    }

    case "setposttime": {
      const time = String(opt(interaction, "time"));
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return reply("That time is not valid. Use a 24-hour HH:MM.", true);
      const tz = opt(interaction, "timezone") as string | undefined;
      if (tz !== undefined) {
        if (!isValidTz(tz)) return reply(`That timezone is not recognised. Use an IANA name such as Europe/London.`, true);
        await setState(env, "post_tz", tz);
      }
      await setState(env, "post_time", time);
      // Clear today's post marker so a freshly set time can fire again today (handy for testing).
      await setState(env, "last_post_date", "");
      return reply(
        `The daily bulletin will now post at ${time} (${tz ?? s.postTz}). Today's bulletin is ready to fire again at that time.`,
        true,
      );
    }

    case "skip": {
      const dur = parseDuration(String(opt(interaction, "duration")));
      if (dur == null) return reply("That duration is not valid. Try something like 3d, 6h, 90m, or 1d6h.", true);
      const oldMs = s.currentTime;
      const newMs = oldMs + dur;
      const reached = await windowAnnouncements(env, oldMs, newMs);
      await setState(env, "current_time", String(newMs));
      const embed = buildBulletin(newMs, reached, {
        intro: `The clock has advanced by ${humanDuration(dur)}.`,
        noneText: "No announcements fell within the skipped period.",
        paused: s.paused,
      });
      if (s.channelId) {
        await postMessage(env, s.channelId, { embeds: [embed] });
        return reply(
          `Advanced the clock by ${humanDuration(dur)} to ${formatDateTime(newMs)}. ` +
            `Posted the bulletin with ${plural(reached.length, "announcement")} to the channel.`,
          true,
        );
      }
      return replyEmbed(embed);
    }

    case "setrate": {
      const dur = parseDuration(String(opt(interaction, "duration")));
      if (dur == null) return reply("That duration is not valid. Try something like 1d, 12h, or 1d6h.", true);
      await setState(env, "advance_rate", String(dur));
      return reply(`The clock will now advance by ${humanDuration(dur)} each day.`, true);
    }

    case "flush": {
      const before = startOfDay(s.currentTime);
      const res = await env.DB.prepare(`DELETE FROM announcements WHERE at_time < ?`).bind(before).run();
      const n = res.meta.changes ?? 0;
      return reply(
        n ? `Cleared ${plural(n, "past announcement")} from before today.` : "There were no past announcements to clear.",
        true,
      );
    }

    case "setchannel": {
      const channelId = (opt(interaction, "channel") as string | undefined) ?? interaction.channel_id;
      if (!channelId) return reply("I could not work out which channel you mean.", true);
      await setState(env, "channel_id", channelId);
      return reply(`The daily bulletin will now be posted in <#${channelId}>.`, true);
    }

    case "setroles": {
      const raw = String(opt(interaction, "roles"));
      const names = raw.split(/[,\s]+/).map((r) => r.trim()).filter(Boolean);
      if (!names.length) return reply("Give at least one role name.", true);
      await setState(env, "admin_roles", JSON.stringify(names));
      return reply(`Admin commands are now limited to these roles: ${names.join(", ")}.`, true);
    }

    case "msg":
      // Always open the multi-line popup; the message is typed there.
      return openMsgModal(String(opt(interaction, "user")));

    case "config": {
      return replyEmbed({
        title: `${CONFIG.botName} settings`,
        color: CONFIG.embedColor,
        fields: [
          { name: "In-universe clock", value: formatDateTime(s.currentTime), inline: false },
          { name: "Advancement", value: s.paused ? "paused" : `${humanDuration(s.advanceRate)} per day`, inline: true },
          { name: "Posts daily at", value: `${s.postTime} (${s.postTz})`, inline: true },
          { name: "Bulletin channel", value: s.channelId ? `<#${s.channelId}>` : "not set", inline: true },
          { name: "Admin roles", value: s.adminRoles.join(", "), inline: false },
        ],
      }, true);
    }

    default:
      return reply("Unknown command.", true);
  }
}

async function handleModal(interaction: Interaction, env: Env): Promise<Response> {
  const cid = interaction.data.custom_id ?? "";
  if (cid.startsWith("msg:")) {
    const s = await loadState(env);
    if (!(await isAuthorized(env, interaction, s.adminRoles))) {
      return reply("You do not have permission to use /msg.", true);
    }
    const userId = cid.slice(4);
    const body = interaction.data.components?.[0]?.components?.[0]?.value ?? "";
    return sendDm(env, userId, body);
  }
  return reply("Unknown submission.", true);
}

// ---------------------------------------------------------------------------
// Slash-command definitions & registration
// ---------------------------------------------------------------------------

const STRING = 3, INTEGER = 4, USER = 6, CHANNEL = 7, NUMBER = 10;

const COMMANDS = [
  { name: "today", description: "Show the current in-universe date/time and today's announcements." },
  { name: "help", description: "Show the list of commands and what they do." },
  { name: "time", description: "Show real-world clock status and countdown to the next automatic post." },
  {
    name: "attack", description: "Work out cohesion damage and casualties from an attack.",
    options: [
      { name: "assault_roll", description: "attacker roll", type: NUMBER, required: true },
      { name: "weaponry", description: "weaponry", type: NUMBER, required: true },
      { name: "deflection_roll", description: "defender roll", type: NUMBER, required: true },
      { name: "protection", description: "protection", type: NUMBER, required: true },
      { name: "cohesion", description: "cohesion 0-100", type: NUMBER, required: true },
      { name: "men", description: "men", type: INTEGER, required: true },
    ],
  },
  {
    name: "announce", description: "Schedule a bulletin announcement.",
    options: [
      { name: "message", description: "The announcement text", type: STRING, required: true },
      { name: "date", description: "In-universe date YYYY-MM-DD (omit to post it next bulletin)", type: STRING, required: false },
      { name: "time", description: "Time of day HH:MM (optional)", type: STRING, required: false },
    ],
  },
  { name: "queue", description: "List all scheduled announcements with their IDs." },
  {
    name: "edit", description: "Edit an announcement by ID.",
    options: [
      { name: "id", description: "Announcement ID", type: INTEGER, required: true },
      { name: "message", description: "New message text", type: STRING, required: false },
      { name: "date", description: "New date (YYYY-MM-DD)", type: STRING, required: false },
      { name: "time", description: "New time (HH:MM)", type: STRING, required: false },
    ],
  },
  {
    name: "delete", description: "Delete an announcement by ID.",
    options: [{ name: "id", description: "Announcement ID", type: INTEGER, required: true }],
  },
  { name: "pause", description: "Pause automatic advancement of the campaign clock." },
  { name: "resume", description: "Resume automatic advancement of the campaign clock." },
  {
    name: "settime", description: "Set the current in-universe date and time.",
    options: [{ name: "datetime", description: "YYYY-MM-DD or YYYY-MM-DD HH:MM", type: STRING, required: true }],
  },
  {
    name: "setposttime", description: "Set the real-world time of the daily bulletin.",
    options: [
      { name: "time", description: "24-hour time HH:MM", type: STRING, required: true },
      { name: "timezone", description: "IANA timezone e.g. Europe/London (optional)", type: STRING, required: false },
    ],
  },
  {
    name: "skip", description: "Advance the clock now, batching any announcements crossed.",
    options: [{ name: "duration", description: "e.g. 3d, 6h, 90m, 1d6h", type: STRING, required: true }],
  },
  {
    name: "setrate", description: "Set how much in-universe time passes per daily tick.",
    options: [{ name: "duration", description: "e.g. 1d, 12h, 1d6h", type: STRING, required: true }],
  },
  { name: "flush", description: "Delete past announcements (dated before today)." },
  {
    name: "setchannel", description: "Set the channel for automatic daily bulletins.",
    options: [{ name: "channel", description: "Target channel (defaults to this one)", type: CHANNEL, required: false }],
  },
  {
    name: "setroles", description: "Configure which role names may use admin commands.",
    options: [{ name: "roles", description: "Comma/space separated role names", type: STRING, required: true }],
  },
  { name: "config", description: "Show the current bot configuration and clock state." },
  {
    name: "msg", description: "Send a direct message to a server member.",
    options: [
      { name: "user", description: "member", type: USER, required: true },
    ],
  },
];

async function registerCommands(env: Env): Promise<Response> {
  const appId = env.DISCORD_APPLICATION_ID;
  const guildId = env.DISCORD_GUILD_ID;
  const path = guildId
    ? `/applications/${appId}/guilds/${guildId}/commands`
    : `/applications/${appId}/commands`;
  return discord(env, "PUT", path, COMMANDS);
}

// ---------------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`${CONFIG.botName} online`);
    }

    // One-time slash-command registration: GET /register?secret=...
    if (request.method === "GET" && url.pathname === "/register") {
      if (url.searchParams.get("secret") !== env.REGISTER_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const res = await registerCommands(env);
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
    }

    if (request.method !== "POST") return new Response("not found", { status: 404 });

    // Verify the Ed25519 signature on every interaction.
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const raw = await request.text();
    if (!signature || !timestamp || !(await verifyKey(raw, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = JSON.parse(raw) as Interaction;
    if (interaction.type === 1) return json({ type: 1 }); // PING -> PONG
    if (interaction.type === 2) {
      await ensureSchema(env);
      return handleCommand(interaction, env);
    }
    if (interaction.type === 5) { // MODAL_SUBMIT
      await ensureSchema(env);
      return handleModal(interaction, env);
    }
    return json({ type: 1 });
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
    const s = await loadState(env);
    if (!s.channelId) return; // nowhere to post yet

    const now = event.scheduledTime;
    const { date, time } = tzParts(now, s.postTz);
    if (s.lastPostDate === date) return; // already posted today
    if (time < s.postTime) return; // configured post time not reached yet

    const oldMs = s.currentTime;
    const newMs = s.paused ? oldMs : oldMs + s.advanceRate;
    const reached = s.paused ? [] : await windowAnnouncements(env, oldMs, newMs);

    if (!s.paused) await setState(env, "current_time", String(newMs));
    await setState(env, "last_post_date", date);

    await postMessage(env, s.channelId, { embeds: [buildBulletin(newMs, reached, { paused: s.paused })] });
  },
};

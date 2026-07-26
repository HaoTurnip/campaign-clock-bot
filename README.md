# 2062 — Campaign Clock & Bulletin Bot

A Discord bot that acts as the official **in-universe clock and daily news bulletin** for a
TTRPG campaign set on Earth in January 2062. Every day, at a configurable real-world time, it
posts the current in-universe date/time to a designated channel and folds in any announcements
scheduled for the period it just advanced through.

It runs entirely on **free, always-available serverless infrastructure** — [Cloudflare
Workers](https://workers.cloudflare.com/) for the logic and [D1](https://developers.cloudflare.com/d1/)
(SQLite) for persistence — with **no recurring cost** and nothing to keep alive. Slash commands
arrive over Discord's HTTP-interactions endpoint; the daily post is driven by a Cron Trigger. No
gateway connection, no VM, no spin-down.

## How it works

- **`fetch()`** verifies each interaction's Ed25519 signature and dispatches the slash command.
- **`scheduled()`** runs every minute (UTC). When the configured local post-time is reached and
  today's bulletin hasn't posted yet, it advances the clock (unless paused) and posts.
- **D1** stores the clock, pause flag, post time/timezone, advancement rate, output channel,
  admin role names, and all announcements. Tables self-create on first use — no manual DB setup.

The whole bot is a single file: [`src/index.ts`](src/index.ts). Everything tunable (bot name,
embed color, default start time, default advancement rate, default post time, default admin roles)
lives in the `CONFIG` object at the top.

## Commands

`/today` is public. Everything else requires an admin role (default **GameMaster** / **dev**, or
any guild administrator).

| Command | What it does |
| --- | --- |
| `/today` | Show the current in-universe date/time and today's announcements. Never removes anything. |
| `/announce <date> <message> [time]` | Schedule an announcement; returns its unique ID. |
| `/queue` | List pending announcements (today or later), chronological, with IDs. |
| `/edit <id> [date] [time] [message]` | Change one or more fields of an announcement. |
| `/delete <id>` | Delete an announcement by ID. |
| `/pause` / `/resume` | Stop / restart automatic clock advancement. |
| `/settime <datetime>` | Set the in-universe clock (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`). |
| `/setposttime <time> [timezone]` | Set the real-world daily post time (24h `HH:MM`, optional IANA tz). |
| `/skip <duration>` | Advance the clock now, posting one batched bulletin for everything crossed. |
| `/setrate <duration>` | Set how much in-universe time passes per daily tick (default `1d`). |
| `/flush` | Delete expired announcements (dated before today). |
| `/setchannel [#channel]` | Set the bulletin channel (defaults to the current channel). |
| `/setroles <names>` | Configure which role names may run admin commands. |
| `/config` | Show current clock and configuration. |

Durations parse as `3d`, `6h`, `90m`, `1d6h`, `2w`. Announcements are date-anchored and persist
until `/delete` or `/flush` — the daily post and `/skip` display them, never silently consume them.

## Deploy (zero recurring cost)

Prerequisites: a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and a Discord
application ([Developer Portal](https://discord.com/developers/applications)) with a bot.

```bash
npm install
npx wrangler login

# 1. Create the D1 database and paste the returned database_id into wrangler.toml
npx wrangler d1 create campaign_clock

# 2. Set secrets (values from the Discord Developer Portal; REGISTER_SECRET is any random string)
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put REGISTER_SECRET

# 3. Publish the Worker (also activates the every-minute Cron Trigger)
npm run deploy
```

Then, in the **Discord Developer Portal → your app → General Information**, set the
**Interactions Endpoint URL** to your deployed Worker URL (e.g.
`https://campaign-clock-bot.<subdomain>.workers.dev/`). Discord sends a verification PING that the
Worker answers automatically.

Finally, register the slash commands once by visiting:

```
https://campaign-clock-bot.<subdomain>.workers.dev/register?secret=<REGISTER_SECRET>
```

For instant, guild-scoped commands during setup, set `DISCORD_GUILD_ID` in `wrangler.toml` before
registering; leave it empty to register globally (can take up to an hour to appear).

Invite the bot with the `applications.commands` and `bot` scopes and permission to send messages
in your bulletin channel, then run `/setchannel` there.

### Optional: auto-deploy from GitHub

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) redeploys on every push to `main`.
Add repository secrets `CLOUDFLARE_API_TOKEN` (Workers-scoped) and `CLOUDFLARE_ACCOUNT_ID`. Using a
**public** repo keeps GitHub Actions free.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the values
npm run dev                      # wrangler dev (uses a local D1)
npm run typecheck
```

## Free-tier headroom

Cloudflare free plan: 100k Worker requests/day (this bot uses ~1,440 cron ticks/day plus your
commands) and D1's 5 GB / 5M row-reads/day / 100k writes/day — orders of magnitude beyond a
campaign's needs.

---
name: weather
description: "Get current weather and forecasts via wttr.in or Open-Meteo. Use when: user asks about weather, temperature, or forecasts for any location. NOT for: historical weather data, severe weather alerts, or detailed meteorological analysis. No API key needed."
homepage: https://wttr.in/:help
metadata: { "openclaw": { "emoji": "🌤️", "requires": { "bins": ["curl"] } } }
---

# Weather Skill

Get current weather conditions and forecasts.

## When to Use

✅ **USE this skill when:**

- "What's the weather?"
- "Will it rain today/tomorrow?"
- "Temperature in [city]"
- "Weather forecast for the week"
- Travel planning weather checks

## When NOT to Use

❌ **DON'T use this skill when:**

- Historical weather data → use weather archives/APIs
- Climate analysis or trends → use specialized data sources
- Hyper-local microclimate data → use local sensors
- Severe weather alerts → check official NWS sources
- Aviation/marine weather → use specialized services (METAR, etc.)

## Location

Always include a city, region, or airport code in weather queries.

## Commands

## Chat-Safe Rules (Important)

- For chat replies, prefer **one quick query** and answer from that result.
- Always use curl time limits on network calls:
  - `--connect-timeout 5`
  - `--max-time 10`
- Prefer compact `format=3` or other short `format=...` responses.
- Avoid these in messaging chats unless the user explicitly asks for full raw output:
  - `?0`
  - `format=v2d`
  - plain `wttr.in/<city>` (large ANSI output can hang/stream slowly)
- On macOS, `timeout` may not exist. Use curl's `--max-time` instead.
- If a weather endpoint is slow/fails, do **one fallback** (for example English city name + `format=3`) and then reply with the best available result. Do not loop on repeated retries.

### Current Weather

```bash
# One-line summary
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=3"

# Detailed current conditions
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?0"

# Specific city
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/New+York?format=3"
```

### Forecasts

```bash
# 3-day forecast
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London"

# Week forecast
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=v2"

# Specific day (0=today, 1=tomorrow, 2=day after)
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?1"
```

### Format Options

```bash
# One-liner
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=%l:+%c+%t+%w"

# JSON output
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=j1"

# PNG image
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London.png"
```

### Format Codes

- `%c` — Weather condition emoji
- `%t` — Temperature
- `%f` — "Feels like"
- `%w` — Wind
- `%h` — Humidity
- `%p` — Precipitation
- `%l` — Location

## Quick Responses

**"What's the weather?"**

```bash
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=%l:+%c+%t+(feels+like+%f),+%w+wind,+%h+humidity"
```

**"Will it rain?"**

```bash
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=%l:+%c+%p"
```

**"Weekend forecast"**

```bash
curl -sS --connect-timeout 5 --max-time 10 "wttr.in/London?format=v2"
```

## Notes

- No API key needed (uses wttr.in)
- Rate limited; don't spam requests
- Works for most global cities
- Supports airport codes: `curl wttr.in/ORD`

---
name: weather
description: "Get current weather and forecasts via wttr.in (primary) or Open-Meteo (fallback). Use when: user asks about weather, temperature, or forecasts for any location. NOT for: historical weather data, severe weather alerts, or detailed meteorological analysis. No API key needed."
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
- **Fallback Strategy**: If wttr.in times out, immediately try Open-Meteo (requires latitude/longitude):
  1. First try: `wttr.in/<city>?format=3`
  2. If timeout (code 28), try Open-Meteo with known coordinates
  3. If both fail, inform user and suggest manual check
- Do not loop on repeated retries.

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

---

## Open-Meteo API (Fallback)

Use Open-Meteo when wttr.in is unavailable or slow.

### Current Weather

```bash
# Nanning, China (lat: 22.82, lon: 108.32)
curl -s --connect-timeout 5 --max-time 10 "https://api.open-meteo.com/v1/forecast?latitude=22.82&longitude=108.32&current_weather=true"

# Parse temperature and weather code
curl -s "https://api.open-meteo.com/v1/forecast?latitude=22.82&longitude=108.32&current_weather=true" | jq -r '.current_weather | "Temp: \(.temperature)°C, Wind: \(.windspeed) km/h, Code: \(.weathercode)"'
```

### Weather Code Mapping

| Code   | Description   | Emoji |
| ------ | ------------- | ----- |
| 0      | Clear sky     | ☀️    |
| 1-3    | Partly cloudy | ⛅    |
| 45, 48 | Fog           | 🌫️    |
| 51-67  | Drizzle/Rain  | 🌧️    |
| 71-77  | Snow          | ❄️    |
| 95-99  | Thunderstorm  | ⛈️    |

### City Coordinates (Common)

| City      | Latitude | Longitude |
| --------- | -------- | --------- |
| Nanning   | 22.82    | 108.32    |
| Shanghai  | 31.23    | 121.47    |
| Beijing   | 39.90    | 116.41    |
| Guangzhou | 23.13    | 113.27    |
| Shenzhen  | 22.55    | 114.06    |
| London    | 51.51    | -0.13     |
| New York  | 40.71    | -74.01    |

### Quick Weather (Chat-Ready)

```bash
# Nanning (one-line, human-readable)
curl -s "https://api.open-meteo.com/v1/forecast?latitude=22.82&longitude=108.32&current_weather=true" | \
  jq -r '"南宁: \(.current_weather.temperature)°C, 风速: \(.current_weather.windspeed) km/h"'

# With weather code translation
curl -s "https://api.open-meteo.com/v1/forecast?latitude=22.82&longitude=108.32&current_weather=true" | \
  jq -r '"南宁: \(.current_weather.temperature)°C, 天气码: \(.current_weather.weathercode)"'
```

### Pros vs Cons

**Open-Meteo:**

- ✅ More reliable, fewer timeouts
- ✅ Free, no rate limiting
- ✅ Returns JSON, easy to parse
- ❌ Requires coordinates (no city name lookup)
- ❌ Less user-friendly output (needs jq for formatting)

**wttr.in:**

- ✅ City name lookup
- ✅ Pretty output formats
- ✅ Unicode weather icons
- ❌ Frequent timeouts in some regions
- ❌ Rate limited

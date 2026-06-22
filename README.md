# SensorDash

React dashboard with a local JSON collector. There is no backend server here: the collector is a Node script that fetches APIs every 15 minutes and writes timestamped JSON into `public/data`. React reads the stored JSON history for charts and tables.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add your API URLs in `collector.config.json` and set each API to `"enabled": true`.

3. Start the collector:

   ```bash
   npm run collect
   ```

4. In another terminal, start the dashboard:

   ```bash
   npm run dev
   ```

## Vercel Deployment

Deploy the GitHub repository to Vercel as a Vite app. The static site reads JSON from `public/data`.

Automatic historical updates are handled by `.github/workflows/collect-sensor-data.yml`. The workflow runs every 15 minutes, fetches Ritel/Witel data, commits updated JSON files, and pushes to `main`. If the Vercel project is connected to this GitHub repo, each workflow commit triggers a new deployment with the latest stored data.

You can also run the workflow manually from the GitHub Actions tab.

## Data Files

- `public/data/history.json` stores full timestamped API snapshots.
- `public/data/readings.json` stores normalized historical rows for station charts.
- `public/data/snapshots/<fetch-time>.json` stores each fetch result separately.
- `public/data/manifest.json` lists the latest snapshot and stored snapshots.

Use `npm run collect:once` to fetch once and exit.

Important: a browser-only React app cannot write files into a project `data` folder. This project keeps React browser-only, and uses the local collector script only for scheduled file writing.

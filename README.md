# Daytrip

A responsive day-trip planner that builds a practical itinerary around your destination, date, group, interests, schedule, and budget.

The app combines AI-assisted planning with place discovery, map routes, weather information, INR budget estimates, and locally saved trips. It includes a review step that checks whether a generated itinerary matches the preferences entered in the planner.

## Features

- Guided, multi-step trip preferences
- AI-assisted itinerary generation (Groq; optional)
- Destination and nearby-place discovery using OpenStreetMap data
- Interactive maps and verified driving routes when routing data is available
- Weather information and forecast support (OpenWeather; optional)
- Optional sourced travel research (Tavily)
- INR budget estimates
- Itinerary consistency review before displaying the plan
- Browser-based saved trips and recent itinerary archive
- Responsive interface

> **Note:** Budget figures are planning estimates, not live quotes. Itinerary review checks consistency with your inputs; it does not guarantee venue quality, opening hours, availability, or suitability.

## Tech stack

- React 19 + TypeScript
- Vite
- Leaflet + React Leaflet
- Express 5 for local API development
- Vercel serverless functions for deployment
- Node.js test runner

## Requirements

- Node.js 20 or later
- npm
- Optional API keys for enhanced planning, research, and weather features

## Getting started

```bash
git clone https://github.com/<your-username>/<your-repository>.git
cd <your-repository>
npm install
```

Create your local environment file from the example:

**macOS / Linux**
```bash
cp .env.example .env
```

**Windows PowerShell**
```powershell
Copy-Item .env.example .env
```

Add the provider keys you want to use to `.env`. Keep this file private; it is excluded from Git.

Start the local development server:

```bash
npm run dev
```

Open the local URL printed in the terminal (by default `http://localhost:5173`).

## Environment variables

All provider keys are optional. Features that depend on an unconfigured provider may be unavailable or use the app's fallback behavior.

| Variable | Purpose | Required |
| --- | --- | --- |
| `GROQ_API_KEY` | Enables AI-assisted itinerary generation | No |
| `GROQ_MODEL` | Groq model used for itinerary generation | No |
| `TAVILY_API_KEY` | Adds sourced travel research context | No |
| `OPENWEATHER_API_KEY` | Enables weather and forecast data | No |
| `PORT` | Local production-server port (default `8787`) | No |

Never expose secret keys in frontend variables such as `VITE_GROQ_API_KEY`. Configure secrets only in the server environment or your hosting provider's environment-variable settings.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts the local Express + Vite development server |
| `npm run build` | Type-checks and builds the production frontend into `dist/` |
| `npm run preview` | Previews the Vite production build |
| `npm start` | Starts the local production Express server |
| `npm test` | Runs the automated Node.js test suite |

## Project structure

```text
.
├── api/                 # Vercel serverless API entry points
├── server/              # Shared API logic and local Express server
├── src/
│   ├── core.ts          # Core planning and itinerary logic
│   ├── types.ts         # Shared TypeScript types
│   ├── ui/              # React interface and map/weather components
│   ├── main.tsx         # Frontend entry point
│   └── style.css        # Application styles
├── tests/               # Automated tests
├── daytrip-data/        # Local itinerary archive (created at runtime)
├── .env.example         # Environment variable template
├── vercel.json          # Vercel deployment configuration
└── vite.config.ts       # Vite configuration
```

## Run tests and build

```bash
npm test
npm run build
```

The tests use mocked external services where appropriate and do not require live provider API keys.

## Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel, choose **Add New → Project** and import the GitHub repository.
3. Keep the detected Vite framework settings, or use:
   - Build command: `npm run build`
   - Output directory: `dist`
4. Add the required provider keys under **Project Settings → Environment Variables**. Use the same names listed in the environment-variable table.
5. Deploy.

The `api/` directory contains the serverless endpoints, while `server/planning.js` contains shared planning and place/route handlers. The local Express server is intended for development and local production runs.

## Data and privacy notes

- Saved trips and browser itinerary history are stored locally in the browser.
- The local PowerShell launcher can also write an archive to `daytrip-data/`.
- Hosted deployments do not provide a persistent server-side itinerary archive by default.
- Place discovery uses OpenStreetMap-based services; routing uses OSRM when route geometry and timing are returned.
- Weather and AI features send the relevant request data to the configured provider.

## Contributing

Issues and pull requests are welcome. For a change, please include a short description of the behavior changed and run `npm test` and `npm run build` before submitting.

## License

No license has been assigned yet. Until a license is added, all rights remain with the copyright holder; do not assume the code is available for reuse, redistribution, or modification.

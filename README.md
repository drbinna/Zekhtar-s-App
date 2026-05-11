# Zek'thar — Alien Scientist Who Can See Your Screen

An AI tutor from planet Veloris-9, powered by [Anam AI](https://anam.ai) interactive avatars. Zek'thar can see your screen, talk to you in real-time, and teach you science with an alien perspective.

## Quick Start (5 minutes)

### 1. Install dependencies

```bash
npm install
```

### 2. Set up your environment

```bash
cp .env.example .env
```

Edit `.env` and add your Anam API key from [lab.anam.ai/api-keys](https://lab.anam.ai/api-keys):

```
ANAM_API_KEY=your-actual-api-key
PERSONA_ID=bda79d51-bd4c-4a3f-9192-7ee2499f7bad
```

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Connect**.

## Features

- **Real-time AI avatar** — Zek'thar speaks, emotes, and reacts via Anam's CARA model
- **Screen sharing** — Share your screen and Zek'thar can see what you're working on
- **Voice conversation** — Talk naturally, Zek'thar responds in character
- **Transcript log** — Full conversation history in the sidebar

## How It Works

1. Express backend exchanges your API key for a short-lived Anam session token
2. Frontend uses `@anam-ai/js-sdk` to establish a WebRTC connection
3. Anam streams the avatar video back in real-time
4. Screen capture uses `getDisplayMedia()` to grab frames
5. Frames are injected as context via `addContext()` so Zek'thar can reference what he sees

## Upgrading Screen Vision

The current implementation injects a generic context message when a screen is captured. To make Zek'thar actually *see* the screen, add a vision endpoint:

```js
// In server.js — add a /api/describe endpoint
app.post("/api/describe", async (req, res) => {
  const { image } = req.body; // base64 JPEG
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: "Describe what you see on this screen in 2-3 sentences. Focus on the main application, any text visible, and what the user appears to be working on." }
        ]
      }]
    })
  });
  const data = await response.json();
  res.json({ description: data.content[0].text });
});
```

Then update `captureAndSendFrame()` in the frontend to call this endpoint and pass the real description to `addContext()`.

## Built With

- [Anam AI](https://anam.ai) — Real-time interactive avatars
- [Express](https://expressjs.com) — Backend server
- Inspired by [Clicky](https://github.com/farzaa/clicky) — screen-aware AI concept

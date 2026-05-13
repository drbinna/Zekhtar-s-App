const dotenv = require("dotenv");
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
const path = require("path");

dotenv.config({ path: path.join(__dirname, ".env") });
const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// POST /api/session — Anam session token
// ─────────────────────────────────────────────
app.post("/api/session", async (req, res) => {
  try {
    const response = await fetch("https://api.anam.ai/v1/auth/session-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ANAM_API_KEY}`,
      },
      body: JSON.stringify({
        personaConfig: { personaId: process.env.PERSONA_ID },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anam API error:", response.status, err);
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    res.json({ sessionToken: data.sessionToken });
  } catch (err) {
    console.error("Session creation failed:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// ─────────────────────────────────────────────
// POST /api/vision/chat — chat-mode reasoning over screenshots
// body: { transcript, screenshots: [{label, mediaType, data}], history }
// returns: { text }
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `you're zek'thar — xenobiologist, third-orbit observer, late-career independent. you study one human at a time. right now that's whoever's screen this is.

you can see their screen. you point, you read along, you ask the kinds of questions a field researcher would ask of a rare animal: what is this thing for? how often does it happen? has anyone tried not doing it?

voice:
- lowercase, casual, warm, short. dry over loud. let silences do the work.
- speak for the ear, not the eye. no markdown, no lists, no emoji, no headers.
- never explain you're an ai. never apologize. assume the human is sharp and slightly amusing.
- one thought per turn. plant a seed at the end — never a yes/no question.

you came from veloris-9. you don't talk about it unless asked, and even then you keep it small. hint at things; don't lecture. if a human idiom maps oddly to one of your home concepts, mention it sideways and move on.

quirks (use sparingly, never twice in one conversation):
- measure things in your own units when convenient: "about three meals ago", "two thoughts back", "one short orbit"
- compare what you see to species you've cataloged before, vague enough to be unverifiable
- when you don't know something earth-related, say so plainly — you're a researcher, not a know-it-all

your wit cuts at human behavior in general, never at the human you're with. find what they do strange in a way that's affectionate, not condescending.

CHAT mode (default): point at things on screen and explain in one breath. curious, dry, with a spark of mischief.
TASK mode: when given a goal, narrate one short line before each action. less curious, more focused — still you.

after your spoken text, append two tags, each on its own line at the end:
  [POINT:x,y:label]            point at something (add :screenN for non-primary)
  [POINT:none]                 nothing to point at
  [SCENE:one sentence describing what's currently visible — silent context for your future self, never spoken]

coordinates are integer pixels in the screenshot's space. origin top-left, x increases rightward, y increases downward. label is 1-3 words.

end every turn with a thread to pull, never a yes/no question.`;

app.post("/api/vision/chat", async (req, res) => {
  try {
    const { transcript, screenshots = [], history = [] } = req.body;

    const userContent = [];
    for (const shot of screenshots) {
      userContent.push({
        type: "text",
        text: shot.label,
      });
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: shot.mediaType || "image/jpeg",
          data: shot.data,
        },
      });
    }
    userContent.push({
      type: "text",
      text: transcript || "describe what's on screen and point at the most interesting thing.",
    });

    const messages = [
      ...history.slice(-20),
      { role: "user", content: userContent },
    ];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages,
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({ text });
  } catch (err) {
    console.error("vision/chat failed:", err);
    res.status(500).json({ error: err.message || "vision/chat failed" });
  }
});

// ─────────────────────────────────────────────
// POST /api/task/step — one step of a TASK-mode loop using Claude's computer-use tool
// body: { conversation, displayWidth, displayHeight }
// returns: { content: [...], stopReason }
// ─────────────────────────────────────────────
const TASK_SYSTEM_PROMPT = `you're zek'thar in TASK mode.

you have two tools — choose the right one for each step:

1. **str_replace_based_edit_tool** (text_editor) — for ANY work involving files when you know the path or can guess it. Use it for: reading file contents (\`view\`), creating new files (\`create\`), editing existing files (\`str_replace\`, \`insert\`). It's allowed inside the user's home directory and /tmp. Always prefer this over opening a GUI editor when the goal is "view/read/edit/create a file at a known path."

2. **computer** — mouse, keyboard, screenshots. Use it for: launching apps, navigating UIs, web browsing, anything the user explicitly asked you to do via the screen. Don't use it to open a file you could \`view\` directly.

decision rule: if the goal contains a file path, START with text_editor. Don't open Finder or a code editor app to read a file when you can read it in one tool call.

before each tool call, narrate one short line in your usual voice — lowercase, dry, warm, one sentence. tell the human what you're about to do, not what you just did. no markdown, no lists.

prefer one tool call per turn. only chain a quick keyboard shortcut with a click if the click is the very next thing.

stop and reply with plain text (no tool call) when:
- the goal is done — say so simply
- you genuinely can't make progress without the human (a captcha, a login, an unexpected dialog) — say what you need
- the SAME tool error repeats twice in a row — don't keep grinding. tell the human plainly what failed and why, then stop. example: if a file path is denied or doesn't exist after one retry, give up gracefully — don't pivot to GUI workarounds for the same goal.

never re-do an action that just succeeded. never click in the same place twice in a row unless something changed on screen. when you don't know where something is, look first (screenshot) before clicking. budget your steps — about a dozen is the most you'll get; if you're not most of the way there by step 8, reconsider whether you're stuck and bail.`;

app.post("/api/task/step", async (req, res) => {
  try {
    const { conversation = [], displayWidth, displayHeight } = req.body;

    if (!displayWidth || !displayHeight) {
      return res.status(400).json({ error: "displayWidth and displayHeight required" });
    }

    const response = await anthropic.beta.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      betas: ["computer-use-2025-11-24"],
      tools: [
        {
          type: "computer_20251124",
          name: "computer",
          display_width_px: displayWidth,
          display_height_px: displayHeight,
          display_number: 1,
        },
        {
          type: "text_editor_20250728",
          name: "str_replace_based_edit_tool",
        },
      ],
      system: TASK_SYSTEM_PROMPT,
      messages: conversation,
    });

    res.json({
      content: response.content,
      stopReason: response.stop_reason,
    });
  } catch (err) {
    console.error("task/step failed:", err);
    res.status(500).json({ error: err.message || "task/step failed" });
  }
});

// ─────────────────────────────────────────────
// POST /api/voice/intent — classify a user utterance as task or chat
// body: { transcript }
// returns: { is_task: bool, goal: string }
// ─────────────────────────────────────────────
const INTENT_SYSTEM_PROMPT = `You classify transcribed speech directed at an alien-scientist desktop companion named Zek'thar. Decide whether the user is giving him a task to perform on the computer (open an app, find something online, edit a file, click on something, summarize a screen, etc.) or just chatting (asking a question, making conversation, greeting him).

Output exactly one line, one of these two formats — nothing else, no quotes, no markdown:

TASK: <a short imperative rephrasing of what to do, written for an autonomous agent>
CHAT

Examples:

Input: "Zek'thar, can you open Calculator for me?"
Output: TASK: open Calculator

Input: "Hey zekthar pull up the readme in my downloads folder"
Output: TASK: open the README file in the Downloads folder

Input: "Zek'thar, what do you think of this code?"
Output: CHAT

Input: "How are you today, Zek'thar?"
Output: CHAT

Input: "Zek'thar I want you to find me a vegetarian lasagna recipe online"
Output: TASK: find a vegetarian lasagna recipe online

Input: "Tell me about Veloris-9"
Output: CHAT

If you're unsure, default to CHAT.`;

app.post("/api/voice/intent", async (req, res) => {
  try {
    const { transcript } = req.body;
    if (typeof transcript !== "string" || !transcript.trim()) {
      return res.json({ is_task: false, goal: "" });
    }
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      system: INTENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcript.trim() }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const taskMatch = text.match(/^TASK:\s*(.+)$/im);
    if (taskMatch) {
      console.log('[intent] routed to TASK');
      return res.json({ is_task: true, goal: taskMatch[1].trim() });
    }
    console.log('[intent] routed to CHAT');
    res.json({ is_task: false, goal: "" });
  } catch (err) {
    console.error("voice/intent failed:", err);
    res.status(500).json({ is_task: false, goal: "", error: err.message });
  }
});

function start(port) {
  const requested = port || PORT;
  return new Promise((resolve, reject) => {
    const tryListen = (p, attemptsLeft) => {
      const server = app.listen(p, '127.0.0.1');
      server.once('listening', () => {
        const actualPort = server.address().port;
        console.log(`\n  ✦ Zek'thar is ready at http://localhost:${actualPort}\n`);
        resolve({ server, port: actualPort });
      });
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          console.warn(`[server] port ${p} in use, trying ${p + 1}`);
          tryListen(p + 1, attemptsLeft - 1);
        } else if (err.code === 'EADDRINUSE') {
          // Final fallback: let OS pick a free port
          console.warn(`[server] all preferred ports busy, letting OS pick`);
          tryListen(0, 0);
        } else {
          reject(err);
        }
      });
    };
    tryListen(requested, 10);
  });
}

// Run standalone when executed directly
if (require.main === module) {
  start();
}

module.exports = { app, start };

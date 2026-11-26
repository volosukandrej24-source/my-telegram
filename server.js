const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const GIFTS_CATALOG = [
  { id: 'plush_pepe', name: 'Plush Pepe', emoji: '🐸', price: 500, rarity: 'Legendary NFT' },
  { id: 'durov_cap', name: "Durov's Cap", emoji: '🧢', price: 350, rarity: 'Mythic NFT' },
  { id: 'astral_shard', name: 'Astral Shard', emoji: '💎', price: 250, rarity: 'Rare NFT' },
  { id: 'magic_potion', name: 'Magic Potion', emoji: '🧪', price: 100, rarity: 'Rare Gift' },
  { id: 'golden_star', name: 'Golden Star', emoji: '🌟', price: 50, rarity: 'Common Gift' }
];

const NFT_MARKET = [
  { type: 'username', value: '@durov', price: 1000 },
  { type: 'username', value: '@king', price: 750 },
  { type: 'username', value: '@crypto', price: 600 },
  { type: 'number', value: '+88800000001', price: 1200 },
  { type: 'number', value: '+88877777777', price: 900 }
];
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(30) UNIQUE NOT NULL,
      first_name VARCHAR(100) DEFAULT 'User',
      username VARCHAR(50) UNIQUE,
      bio TEXT DEFAULT '',
      stars_balance INT DEFAULT 500,
      is_premium BOOLEAN DEFAULT FALSE,
      is_verified BOOLEAN DEFAULT FALSE,
      nft_usernames JSONB DEFAULT '[]',
      nft_numbers JSONB DEFAULT '[]',
      gifts JSONB DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      title VARCHAR(100) NOT NULL,
      username VARCHAR(50) UNIQUE,
      owner_id INT,
      is_verified BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INT,
      receiver_id INT,
      channel_id INT,
      text TEXT,
      gift_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    UPDATE users SET stars_balance = 1000 WHERE stars_balance < 0;
  `);
}
initDB();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pendingCodes = new Map();
const userPhones = new Map();

bot.onText(/\/start/, (msg) => {
  const cid = msg.chat.id;
  bot.sendMessage(cid, '✈️ *PointGram ID*\n\nВыбери тип виртуального номера:', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🇺🇸 США (+1)', callback_data: 'num_1' }, { text: '🇷🇺 РФ (+7)', callback_data: 'num_7' }],
        [{ text: '💎 Анонимный (+888)', callback_data: 'num_888' }]
      ]
    }
  });
});

bot.on('callback_query', (q) => {
  const cid = q.message.chat.id;
  const rnd = (n) => Math.floor(Math.random() * Math.pow(10, n)).toString().padStart(n, '0');
  let phone = q.data === 'num_1' ? `+1${rnd(10)}` : q.data === 'num_7' ? `+7${rnd(10)}` : `+888${rnd(8)}`;
  userPhones.set(phone, cid);
  bot.sendMessage(cid, `✅ Твой номер: \`${phone}\`\nВведи его в приложении **PointGram**.`, { parse_mode: 'Markdown' });
});
  app.post('/api/auth/send-code', (req, res) => {
  const { phone } = req.body;
  const cid = userPhones.get(phone);
  if (!cid) return res.status(400).json({ error: 'Сначала получи этот номер в боте (/start)' });
  const code = Math.floor(10000 + Math.random() * 90000).toString();
  pendingCodes.set(phone, code);
  bot.sendMessage(cid, `🔐 Код входа в PointGram: *${code}*`, { parse_mode: 'Markdown' });
  res.json({ ok: true });
});

app.post('/api/auth/verify-code', async (req, res) => {
  const { phone, code } = req.body;
  if (pendingCodes.get(phone) !== code) return res.status(400).json({ error: 'Неверный код' });
  pendingCodes.delete(phone);
  let u = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  if (!u.rows.length) {
    u = await pool.query('INSERT INTO users (phone, first_name) VALUES ($1, $2) RETURNING *', [phone, 'User ' + phone.slice(-4)]);
  }
  res.json({ user: u.rows[0] });
});

app.get('/api/bootstrap/:id', async (req, res) => {
  const me = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  const users = await pool.query('SELECT id, phone, first_name, username, bio, is_premium, is_verified, gifts FROM users ORDER BY id DESC');
  const channels = await pool.query('SELECT * FROM channels ORDER BY id DESC');
  res.json({ me: me.rows[0], users: users.rows, channels: channels.rows, giftsCatalog: GIFTS_CATALOG, nftMarket: NFT_MARKET });
});

app.post('/api/profile/update', async (req, res) => {
  const { id, first_name, username, bio, phone } = req.body;
  const cur = await pool.query('SELECT phone FROM users WHERE id = $1', [id]);
  const nextPhone = phone || cur.rows[0].phone;
  await pool.query('UPDATE users SET first_name=$1, username=$2, bio=$3, phone=$4 WHERE id=$5', [first_name, username || null, bio, nextPhone, id]);
  res.json({ ok: true });
});

app.post('/api/channels/create', async (req, res) => {
  const { title, username, ownerId } = req.body;
  await pool.query('INSERT INTO channels (title, username, owner_id) VALUES ($1, $2, $3)', [title, username || null, ownerId]);
  res.json({ ok: true });
});

app.get('/api/messages/direct/:u1/:u2', async (req, res) => {
  const { u1, u2 } = req.params;
  const m = await pool.query('SELECT * FROM messages WHERE channel_id IS NULL AND ((sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)) ORDER BY id ASC', [u1, u2]);
  res.json(m.rows);
});

app.get('/api/messages/channel/:cid', async (req, res) => {
  const m = await pool.query('SELECT m.*, u.first_name as sender_name FROM messages m LEFT JOIN users u ON m.sender_id=u.id WHERE m.channel_id=$1 ORDER BY m.id ASC', [req.params.cid]);
  res.json(m.rows);
});
app.post('/api/shop/buy-premium', async (req, res) => {
  const { userId } = req.body;
  const uRes = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  const user = uRes.rows;
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.is_premium) return res.status(400).json({ error: 'Premium уже подключён' });
  if (user.stars_balance < 200) return res.status(400).json({ error: 'Нужно 200 ⭐️' });
  await pool.query('UPDATE users SET stars_balance = stars_balance - 200, is_premium = TRUE WHERE id=$1', [userId]);
  res.json({ ok: true });
});

app.post('/api/shop/buy-nft', async (req, res) => {
  const { userId, type, value, price } = req.body;
  const uRes = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  const user = uRes.rows;
  if (!user || user.stars_balance < price) return res.status(400).json({ error: 'Недостаточно звёзд ⭐️' });
  const col = type === 'number' ? 'nft_numbers' : 'nft_usernames';
  await pool.query(`UPDATE users SET stars_balance = stars_balance - $1, ${col} = ${col} || $2::jsonb WHERE id=$3`, [price, JSON.stringify([value]), userId]);
  res.json({ ok: true });
});

app.post('/api/shop/send-gift', async (req, res) => {
  const { senderId, receiverId, giftId } = req.body;
  const gift = GIFTS_CATALOG.find(g => g.id === giftId);
  const sRes = await pool.query('SELECT * FROM users WHERE id=$1', [senderId]);
  const sender = sRes.rows;
  if (!gift || !sender || sender.stars_balance < gift.price) return res.status(400).json({ error: 'Недостаточно звёзд ⭐️' });
  await pool.query('UPDATE users SET stars_balance = stars_balance - $1 WHERE id=$2', [gift.price, senderId]);
  const giftItem = { ...gift, from: sender.first_name, date: new Date().toISOString() };
  await pool.query('UPDATE users SET gifts = gifts || $1::jsonb WHERE id=$2', [JSON.stringify([giftItem]), receiverId]);
  const msg = await pool.query('INSERT INTO messages (sender_id, receiver_id, text, gift_json) VALUES ($1,$2,$3,$4) RETURNING *', [senderId, receiverId, `Подарок: ${gift.name}`, JSON.stringify(giftItem)]);
  io.to('user_' + senderId).to('user_' + receiverId).emit('receive_message', msg.rows);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/data', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Неверный пароль' });
  const users = await pool.query('SELECT * FROM users ORDER BY id ASC');
  const channels = await pool.query('SELECT * FROM channels ORDER BY id ASC');
  res.json({ users: users.rows, channels: channels.rows, giftsCatalog: GIFTS_CATALOG });
});

app.post('/api/admin/update-user', async (req, res) => {
  const { password, userId, addStars, toggleVerify, togglePremium, giveNftNumber, giveNftUser, giveGiftId } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Доступ запрещён' });
  const uRes = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  const u = uRes.rows;
  if (!u) return res.status(404).json({ error: 'Юзер не найден' });
  const newStars = Math.max(0, u.stars_balance + (parseInt(addStars) || 0));
  const newVer = toggleVerify ? !u.is_verified : u.is_verified;
  const newPrem = togglePremium ? !u.is_premium : u.is_premium;
  let nums = u.nft_numbers || [], unames = u.nft_usernames || [], gifts = u.gifts || [];
  if (giveNftNumber) nums = [...nums, giveNftNumber];
  if (giveNftUser) unames = [...unames, giveNftUser];
  if (giveGiftId) {
    const g = GIFTS_CATALOG.find(x => x.id === giveGiftId);
    if (g) gifts = [...gifts, { ...g, from: 'PointGram Admin', date: new Date().toISOString() }];
  }
  await pool.query('UPDATE users SET stars_balance=$1, is_verified=$2, is_premium=$3, nft_numbers=$4, nft_usernames=$5, gifts=$6 WHERE id=$7',
    [newStars, newVer, newPrem, JSON.stringify(nums), JSON.stringify(unames), JSON.stringify(gifts), userId]);
  res.json({ ok: true });
});

app.post('/api/admin/verify-channel', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Доступ запрещён' });
  await pool.query('UPDATE channels SET is_verified = NOT is_verified WHERE id=$1', [req.body.channelId]);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.on('register_socket', (uid) => socket.join('user_' + uid));
  socket.on('join_channel', (cid) => socket.join('ch_' + cid));
  socket.on('send_message', async (data) => {
    const { sender_id, receiver_id, channel_id, text } = data;
    const saved = await pool.query('INSERT INTO messages (sender_id, receiver_id, channel_id, text) VALUES ($1,$2,$3,$4) RETURNING *', [sender_id, receiver_id || null, channel_id || null, text]);
    const u = await pool.query('SELECT first_name FROM users WHERE id=$1', [sender_id]);
    const payload = { ...saved.rows, sender_name: u.rows?.first_name };
    if (channel_id) io.to('ch_' + channel_id).emit('receive_message', payload);
    else io.to('user_' + sender_id).to('user_' + receiver_id).emit('receive_message', payload);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('PointGram running on port ' + PORT));
         

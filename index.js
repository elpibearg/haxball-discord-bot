const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const express = require('express');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const API_URL = process.env.API_URL;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ===== SLASH COMMAND =====
const commands = [
  new SlashCommandBuilder()
    .setName('codigo')
    .setDescription('Genera un código para registrarte en HaxBall')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

// Registrar comandos
(async () => {
  try {
    console.log('Registrando comandos...');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Comandos registrados');
  } catch (err) {
    console.error('Error registrando comandos:', err);
  }
})();

// ===== COOLDOWN =====
const cooldowns = new Map();
const COOLDOWN_TIME = 60_000; // 1 minuto

client.on('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'codigo') return;

  const now = Date.now();
  const last = cooldowns.get(interaction.user.id);

  if (last && now - last < COOLDOWN_TIME) {
    return interaction.reply({
      content:
        'Ya generaste un código hace poco.\n\n' +
        'Esperá un minuto antes de pedir otro.',
      ephemeral: true
    });
  }

  cooldowns.set(interaction.user.id, now);

  await interaction.deferReply({ ephemeral: true });

  try {
    const response = await fetch(`${API_URL}/generate-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discordId: interaction.user.id,
        username: interaction.user.username
      })
    });

    if (response.status === 429) {
      return interaction.editReply(
        'Estás solicitando códigos muy rápido.\n\n' +
        'Esperá un momento e intentá de nuevo.'
      );
    }

    if (!response.ok) {
      throw new Error(`API error ${response.status}`);
    }

    const data = await response.json();

    await interaction.editReply({
      content:
        'Código de registro\n' +
        '────────────────\n' +
        `**\`${data.code}\`**\n\n` +
        'Usalo en HaxBall con:\n' +
        `\`!registrarse ${data.code}\`\n\n` +
        'Válido por 5 minutos ⏱️'
    });
  } catch (err) {
    console.error('Error generando código:', err);
    await interaction.editReply(
      'No se pudo generar el código en este momento.\n\n' +
      'Probá nuevamente en unos segundos.'
    );
  }
});

client.login(TOKEN);

// ===== KEEP ALIVE =====
const app = express();
app.get('/', (_, res) => res.send('Bot activo'));
app.listen(3000, () => console.log('Keep-alive OK'));

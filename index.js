const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const API_URL = process.env.API_URL;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName('codigo')
    .setDescription('Genera un código para registrarte en HaxBall')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Registrando comandos...');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Comandos registrados!');
  } catch (error) {
    console.error(error);
  }
})();

client.on('ready', () => {
  console.log(`Bot ${client.user.tag} está online!`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'codigo') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      console.log('Generando código para:', interaction.user.username);
      
      const response = await fetch(`${API_URL}/generate-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discordId: interaction.user.id,
          username: interaction.user.username
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      console.log('Código generado:', data.code);
      
      await interaction.editReply({
        content: `🔑 Tu código de registro es: \`${data.code}\`\n\nUsa \`!registrarse ${data.code}\` en HaxBall.\n⏰ Expira en 5 minutos.`
      });
    } catch (error) {
      console.error('Error completo:', error);
      await interaction.editReply({
        content: `❌ Error al generar código.\n\nDetalles: ${error.message}`
      });
    }
  }
});

client.login(TOKEN);
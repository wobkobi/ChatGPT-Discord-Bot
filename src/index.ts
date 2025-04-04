import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import {
  Client,
  Collection,
  GatewayIntentBits,
  Interaction,
  Message,
  Partials,
} from "discord.js";
import dotenv from "dotenv";
import { existsSync, readdirSync } from "fs";
import OpenAI from "openai";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { cloneUserId } from "./data/characterDescription.js";
import { handleNewMessage, run } from "./handlers/createMessage.js";
import { initializeGeneralMemory } from "./memory/generalMemory.js";
import { initializeUserMemory } from "./memory/userMemory.js";
import logger from "./utils/logger.js";

dotenv.config();

// Determine the commands folder based on production status.
const prodCommandsPath = join(resolve(), "build", "commands");
const devCommandsPath = join(resolve(), "src", "commands");
const commandsPath = existsSync(prodCommandsPath)
  ? prodCommandsPath
  : devCommandsPath;
const fileExtension = existsSync(prodCommandsPath) ? ".js" : ".ts";

logger.info(`Loading commands from: ${commandsPath}`);

// Create the Discord client with required intents and partials.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Extend the client with a commands collection.
client.commands = new Collection();

// Dynamically load command files.
const commandFiles = readdirSync(commandsPath).filter((file) =>
  file.endsWith(fileExtension)
);
for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const fileUrl = pathToFileURL(filePath).href;
  const commandModule = await import(fileUrl);
  if (commandModule.data && commandModule.execute) {
    client.commands.set(commandModule.data.name, commandModule);
  }
}
logger.info(`Loaded ${client.commands.size} slash command(s).`);

// Register global slash commands.
async function registerGlobalCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN!);
  const commandData = Array.from(client.commands.values()).map((cmd) =>
    cmd.data.toJSON()
  );
  try {
    logger.info("Registering global slash commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
      body: commandData,
    });
    logger.info("Global slash commands registered.");
  } catch (error) {
    logger.error("Failed to register global commands:", error);
  }
}

// Create a single OpenAI client instance.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Process incoming messages.
client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  // Process direct messages immediately.
  if (!message.guild) {
    (await handleNewMessage(openai, client))(message);
    return;
  }

  // For guild messages from the clone user:
  // If the clone user does not mention the bot, update clone memory and do not reply.
  if (
    message.author.id === cloneUserId &&
    !message.mentions.has(client.user?.id ?? "")
  ) {
    (await handleNewMessage(openai, client))(message);
    return;
  }

  // For other guild messages, check if the bot is mentioned.
  const isMentioned = message.mentions.has(client.user?.id ?? "");
  // Generate a random chance to interject (1 in 50 chance).
  const randomChance = Math.random();
  const shouldInterject = randomChance < 1 / 50;
  logger.info(
    `Random chance for interjection: ${randomChance.toFixed(4)} (should interject: ${shouldInterject})`
  );

  // Process the message if the bot is mentioned or if interjection condition is met.
  if (isMentioned || shouldInterject) {
    (await handleNewMessage(openai, client))(message);
  }
});

// Handle slash command interactions.
client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (error: unknown) {
    logger.error("Error executing command:", error);
    const replyOptions = {
      content: "There was an error executing that command!",
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOptions);
    } else {
      await interaction.reply(replyOptions);
    }
  }
});

// When the bot is ready, register commands, initialize memory, and run handlers.
client.once("ready", async () => {
  logger.info("Bot is ready.");
  await registerGlobalCommands();
  await initializeGeneralMemory();
  await initializeUserMemory();
  logger.info("Memory initialized.");
  await run(client);
});

// Log in the bot.
client
  .login(process.env.BOT_TOKEN)
  .then(() => logger.info("Bot logged in successfully."))
  .catch((error) => logger.error("Failed to log in:", error));

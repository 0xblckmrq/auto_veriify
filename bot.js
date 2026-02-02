require("dotenv").config();
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  SlashCommandBuilder
} = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { ethers } = require("ethers");

// ===== CONFIG =====
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.WHITELIST_API_KEY;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const PASSPORT_API_KEY = process.env.PASSPORT_API_KEY;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !API_KEY || !EXTERNAL_URL || !PASSPORT_API_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const API_URL = "http://manifest.human.tech/api/covenant/signers-export";

// ===== EXPRESS SERVER =====
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));

// ===== DISCORD CLIENT =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// ===== CHALLENGES & COOLDOWN =====
const challenges = new Map();
const cooldowns = new Map();
const COOLDOWN_SECONDS = 300;

// ===== REGISTER /verify SLASH COMMAND =====
(async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Start wallet verification")
      .addStringOption(opt =>
        opt.setName("wallet")
          .setDescription("Your wallet address")
          .setRequired(true)
      )
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("Slash commands registered");
})();

// ===== HELPERS =====
async function fetchWhitelist() {
  const res = await fetch(`${API_URL}?apiKey=${API_KEY}`);
  const json = await res.json();
  return json.signers || [];
}

async function fetchPassportScore(wallet) {
  const url = `https://api.passport.xyz/v2/stamps/9325/score/${wallet}`;

  const res = await fetch(url, {
    headers: {
      "X-API-KEY": PASSPORT_API_KEY
    }
  });

  if (!res.ok) throw new Error("Passport API failed");

  const json = await res.json();
  return Number(json.score ?? json?.data?.score ?? 0);
}

// ===== DISCORD EVENTS =====
client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const member = interaction.member;

  if (interaction.commandName === "verify") {
    const wallet = interaction.options.getString("wallet").toLowerCase();
    const userId = interaction.user.id.toString();

    await interaction.deferReply({ ephemeral: true });

    const now = Date.now();
    const last = cooldowns.get(userId) || 0;
    if (now - last < COOLDOWN_SECONDS * 1000) {
      const remaining = Math.ceil((COOLDOWN_SECONDS * 1000 - (now - last)) / 1000);
      return interaction.editReply({ content: `⏳ You can verify again in ${remaining} seconds.` });
    }
    cooldowns.set(userId, now);

    const list = await fetchWhitelist();
    const entry = list.find(w =>
      w.walletAddress?.toLowerCase() === wallet &&
      w.covenantStatus?.toUpperCase() === "SIGNED" &&
      w.humanityStatus?.toUpperCase() === "VERIFIED"
    );

    if (!entry) return interaction.editReply({ content: "❌ Wallet not eligible: must be SIGNED + VERIFIED." });

    try {
      const channel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });

      const challenge = `Verify ownership for ${wallet} at ${Date.now()}`;
      challenges.set(userId, { challenge, wallet, channelId: channel.id });

      const signerUrl = `${EXTERNAL_URL.replace(/\/$/, "")}/signer.html?userId=${userId}&challenge=${encodeURIComponent(challenge)}`;

      await channel.send(`
# human.tech Covenant Signatory Verification

Click the link to connect your wallet and sign:

🔗 ${signerUrl}
      `);

      return interaction.editReply({ content: `✅ Private verification channel created: ${channel}` });

    } catch (err) {
      console.error(err);
      return interaction.editReply({ content: "❌ Failed to create verification channel." });
    }
  }
});

// ===== SIGNATURE ENDPOINT =====
app.post("/api/signature", async (req, res) => {
  const { userId, signature } = req.body;
  if (!userId || !signature) return res.status(400).json({ error: "Missing userId or signature" });

  const data = challenges.get(userId.toString());
  if (!data) return res.status(400).json({ error: "No active verification" });

  try {
    const recovered = ethers.verifyMessage(data.challenge, signature);
    if (recovered.toLowerCase() !== data.wallet.toLowerCase())
      return res.status(400).json({ error: "Signature mismatch" });

    const guild = client.guilds.cache.get(GUILD_ID);
    const member = await guild.members.fetch(userId);

    const grantedRoles = [];

    const baseRole = guild.roles.cache.find(r => r.name === "Covenant Verified Signatory");
    if (baseRole) {
      await member.roles.add(baseRole);
      grantedRoles.push(baseRole.name);
    }

    let score = 0;
    try {
      score = await fetchPassportScore(data.wallet);
    } catch (e) {
      console.error("Passport lookup failed:", e.message);
    }

    if (score >= 70) {
      const chosen = guild.roles.cache.find(r => r.name === "Chosen One");
      if (chosen) {
        await member.roles.add(chosen);
        grantedRoles.push(chosen.name);
      }
    }

    if (score >= 20) {
      const og = guild.roles.cache.find(r => r.name === "O.G. HUMN");
      if (og) {
        await member.roles.add(og);
        grantedRoles.push(og.name);
      }
    }

    const channel = guild.channels.cache.get(data.channelId);
    if (channel) {
      await channel.send(
        `✅ **Wallet verified**\n\n🧮 Passport score: **${score}**\n🏷 Roles granted: **${grantedRoles.join(", ") || "None"}**\n\nChannel will close shortly…`
      );
      setTimeout(() => channel.delete().catch(() => {}), 8000);
    }

    challenges.delete(userId);

    return res.json({ success: true, score, roles: grantedRoles });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

client.login(TOKEN);

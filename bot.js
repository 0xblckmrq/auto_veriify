require("dotenv").config();
const path = require("path");
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField, ChannelType, SlashCommandBuilder } = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { ethers } = require("ethers");

// ===== CONFIG =====
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const API_KEY = process.env.WHITELIST_API_KEY;
const INFURA_KEY = process.env.INFURA_KEY;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !API_KEY || !EXTERNAL_URL || !INFURA_KEY) {
  console.error("Missing environment variables");
  process.exit(1);
}

const API_URL = "http://manifest.human.tech/api/covenant/signers-export";

// ===== EXPRESS SERVER =====
const app = express();
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

// ===== DYNAMIC SIGNER PAGE =====
app.get("/signer.html", (req, res) => {
  const challenge = req.query.challenge || "";
  const userId = req.query.userId || "";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>human.tech Covenant Signatory Verification</title>
  <style>
    body { font-family: sans-serif; padding: 20px; max-width: 600px; margin:auto; }
    input { width: 90%; padding: 8px; margin-bottom: 10px; }
    button { padding: 10px 14px; font-size:16px; cursor:pointer; margin-right:10px; }
    #status, #signature { margin-top: 10px; word-break: break-word; }
  </style>
</head>
<body>
  <h2>human.tech Covenant Signatory Verification</h2>
  <p>Connect the wallet used to sign the covenant and sign the challenge below.</p>

  <p>Challenge message (auto-filled):</p>
  <input type="text" id="msg" readonly value="${challenge}">
  <br>
  <button id="signBtn">Connect & Sign</button>
  <button id="retryBtn" style="display:none">Retry Signing</button>

  <p id="status"></p>
  <p id="signature"></p>

  <script src="https://cdn.jsdelivr.net/npm/@walletconnect/web3modal@2.8.0/dist/index.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/ethers@6.9.0/dist/ethers.umd.min.js"></script>

  <script>
    const challenge = "${challenge}";
    const userId = "${userId}";
    const INFURA_KEY = "${INFURA_KEY}";

    const msgInput = document.getElementById("msg");
    const status = document.getElementById("status");
    const sigOutput = document.getElementById("signature");
    const btn = document.getElementById("signBtn");
    const retryBtn = document.getElementById("retryBtn");

    let signer;
    let isWalletConnect = false;
    let wcProvider;

    async function signAndSubmit() {
      try {
        status.innerText = "Signing challenge...";
        const sig = await signer.signMessage(challenge);
        sigOutput.innerText = sig;

        status.innerText = "Submitting signature to bot...";
        const resp = await fetch("/api/signature", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: userId.toString(), signature: sig })
        });

        const result = await resp.json();
        if (result.success) {
          status.innerText = "✅ Verified! Role assigned. Private channel will auto-delete.";
          retryBtn.style.display = "none";
        } else {
          status.innerText = "❌ Verification failed: " + (result.error || "Unknown error");
          if (isWalletConnect) retryBtn.style.display = "inline-block";
        }

      } catch (err) {
        console.error(err);
        status.innerText = "❌ Error signing: " + (err.message || err);
        if (isWalletConnect) retryBtn.style.display = "inline-block";
      }
    }

    btn.onclick = async () => {
      status.innerText = "Connecting wallet...";
      try {
        if (window.ethereum) {
          const provider = new ethers.BrowserProvider(window.ethereum);
          await provider.send("eth_requestAccounts", []);
          signer = await provider.getSigner();
          isWalletConnect = false;
          status.innerText = "Wallet connected via injected provider.";
        } else {
          isWalletConnect = true;
          const web3Modal = new window.Web3Modal.default({
            walletConnectVersion: 2,
            chains: [1],
            rpcMap: { 1: "https://mainnet.infura.io/v3/" + INFURA_KEY }
          });

          wcProvider = await web3Modal.connect();
          const provider = new ethers.providers.Web3Provider(wcProvider);
          signer = provider.getSigner();

          status.innerText = "WalletConnect v2 connected: approve signing request in your wallet.";
        }

        await signAndSubmit();
      } catch (err) {
        console.error(err);
        status.innerText = "❌ Wallet connection error: " + (err.message || err);
        if (isWalletConnect) retryBtn.style.display = "inline-block";
      }
    };

    retryBtn.onclick = async () => {
      if (!signer) return alert("Wallet not connected yet.");
      retryBtn.style.display = "none";
      await signAndSubmit();
    };
  </script>
</body>
</html>
  `;
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

// ===== DISCORD EVENTS =====
client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const member = interaction.member;

  if (interaction.commandName === "verify") {
    const wallet = interaction.options.getString("wallet").toLowerCase();
    const userId = interaction.user.id.toString();

    const now = Date.now();
    const last = cooldowns.get(userId) || 0;
    if (now - last < COOLDOWN_SECONDS * 1000) {
      const remaining = Math.ceil((COOLDOWN_SECONDS * 1000 - (now - last)) / 1000);
      return interaction.reply({ content: `⏳ You can verify again in ${remaining} seconds.`, ephemeral: true });
    }
    cooldowns.set(userId, now);

    const list = await fetchWhitelist();
    const entry = list.find(w =>
      w.walletAddress?.toLowerCase() === wallet &&
      w.covenantStatus?.toUpperCase() === "SIGNED" &&
      w.humanityStatus?.toUpperCase() === "VERIFIED"
    );

    if (!entry) return interaction.reply({ content: "❌ Wallet not eligible: must be SIGNED + VERIFIED.", ephemeral: true });

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

Click the link to connect your wallet and sign the challenge automatically:

🔗 ${signerUrl}

Verification is automatic. Role will be assigned after signing, channel deletes automatically.
      `);

      return interaction.reply({ content: `✅ Private verification channel created: ${channel}`, ephemeral: true });

    } catch (err) {
      console.error(err);
      return interaction.reply({ content: "❌ Failed to create verification channel.", ephemeral: true });
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
    if (recovered.toLowerCase() !== data.wallet.toLowerCase()) return res.status(400).json({ error: "Signature mismatch" });

    const guild = client.guilds.cache.get(GUILD_ID);
    const member = await guild.members.fetch(userId);

    const role = guild.roles.cache.find(r => r.name === "Covenant Verified Signatory");
    if (role) await member.roles.add(role);

    challenges.delete(userId);

    const channel = guild.channels.cache.get(data.channelId);
    if (channel) setTimeout(() => channel.delete().catch(() => {}), 5000);

    return res.json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Verification failed" });
  }
});

client.login(TOKEN);

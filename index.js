
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  AuditLogEvent,
  PermissionFlagsBits,
} = require('discord.js');

// ------------------------------------------------------------
// Environment / Config
// ------------------------------------------------------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional: instant guild-scoped command deploy
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const COLOR = 0x2b2d31; // neutral dark embed color
const COLOR_SUCCESS = 0x57f287;
const COLOR_DANGER = 0xed4245;
const COLOR_WARN = 0xfee75c;

if (!TOKEN || !CLIENT_ID) {
  console.error('[FATAL] DISCORD_TOKEN and CLIENT_ID must be set in your environment variables.');
  process.exit(1);
}

// ------------------------------------------------------------
// Simple JSON Database
// ------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

class Database {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ guilds: {} }, null, 2));
    this.data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    this._saveTimeout = null;
  }

  save() {
    // debounce writes so bursts of activity don't hammer disk I/O
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = setTimeout(() => {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2));
    }, 500);
  }

  guild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = {
        config: {
          logChannel: null,
          modLogChannel: null,
          securityLogChannel: null,
          staffRoles: [],
          adminRoles: [],
          prefix: '!',
          antinuke: {
            enabled: true,
            punishment: 'ban', // 'ban' | 'kick' | 'strip_roles'
            whitelistUsers: [],
            whitelistRoles: [],
            thresholds: {
              channelDelete: { limit: 3, window: 10 },
              channelCreate: { limit: 5, window: 10 },
              roleDelete: { limit: 3, window: 10 },
              roleCreate: { limit: 5, window: 10 },
              ban: { limit: 3, window: 10 },
              kick: { limit: 3, window: 10 },
              webhookCreate: { limit: 3, window: 10 },
              memberPrune: { limit: 1, window: 10 },
            },
            antiBot: true,
            antiBotWhitelist: [],
          },
          tickets: {
            enabled: false,
            panelChannel: null,
            transcriptChannel: null,
            staffRoles: [],
            categories: [
              { id: 'general', label: 'General Support', emoji: '🎫' },
              { id: 'report', label: 'Report a User', emoji: '🚨' },
              { id: 'appeal', label: 'Appeal', emoji: '📄' },
            ],
            counter: 0,
            cooldownSeconds: 60,
          },
          welcome: { enabled: false, channel: null, message: 'Welcome {user} to {server}! We now have {count} members.' },
          goodbye: { enabled: false, channel: null, message: '{user} has left {server}.' },
          levels: { enabled: false, announceChannel: null, xpMin: 15, xpMax: 25, cooldownSeconds: 60 },
          reactionRoles: {}, // messageId -> [{ roleId, emoji/label, customId }]
        },
        warnings: {},        // userId -> [{ id, reason, moderatorId, timestamp }]
        cases: [],           // [{ id, type, userId, moderatorId, reason, timestamp }]
        caseCounter: 0,
        tickets: {},          // ticketChannelId -> {...}
        ticketCooldowns: {},  // userId -> timestamp
        afk: {},              // userId -> { reason, since }
        levels: {},            // userId -> { xp, level, lastMessage }
      };
      this.save();
    }
    return this.data.guilds[guildId];
  }
}

const db = new Database();

// ------------------------------------------------------------
// Client
// ------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
});

client.commands = new Collection();
// in-memory anti-nuke action tracking: guildId -> userId -> actionType -> [timestamps]
client.nukeTracking = new Collection();
// in-memory lockdown state
client.lockdownGuilds = new Set();


// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function baseEmbed(color = COLOR) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}

function isOwner(userId) {
  return OWNER_IDS.includes(userId);
}

function isStaff(member, guildData) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const staffRoles = guildData.config.staffRoles || [];
  return member.roles.cache.some(r => staffRoles.includes(r.id));
}

function isAdmin(member, guildData) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const adminRoles = guildData.config.adminRoles || [];
  return member.roles.cache.some(r => adminRoles.includes(r.id));
}

function isWhitelisted(userId, member, guildData) {
  if (isOwner(userId)) return true;
  const wl = guildData.config.antinuke;
  if (wl.whitelistUsers.includes(userId)) return true;
  if (member && member.roles.cache.some(r => wl.whitelistRoles.includes(r.id))) return true;
  return false;
}

async function getLogChannel(guild, guildData, type = 'log') {
  const id =
    type === 'mod' ? guildData.config.modLogChannel :
    type === 'security' ? guildData.config.securityLogChannel :
    guildData.config.logChannel;
  if (!id) return null;
  try {
    const ch = await guild.channels.fetch(id).catch(() => null);
    return ch;
  } catch {
    return null;
  }
}

async function sendLog(guild, guildData, type, embed) {
  const channel = await getLogChannel(guild, guildData, type);
  if (channel) channel.send({ embeds: [embed] }).catch(() => {});
}

function newCase(guildData, { type, userId, moderatorId, reason }) {
  guildData.caseCounter += 1;
  const c = { id: guildData.caseCounter, type, userId, moderatorId, reason: reason || 'No reason provided', timestamp: Date.now() };
  guildData.cases.push(c);
  db.save();
  return c;
}

function addWarning(guildData, userId, moderatorId, reason) {
  if (!guildData.warnings[userId]) guildData.warnings[userId] = [];
  const warning = { id: guildData.warnings[userId].length + 1, reason: reason || 'No reason provided', moderatorId, timestamp: Date.now() };
  guildData.warnings[userId].push(warning);
  db.save();
  return warning;
}

function fmtUser(userOrId) {
  if (!userOrId) return 'Unknown';
  if (typeof userOrId === 'string') return `<@${userOrId}>`;
  return `${userOrId.tag ? userOrId.tag : userOrId.username} (<@${userOrId.id}>)`;
}

function parseDuration(str) {
  // supports 10s 5m 2h 1d
  const match = /^(\d+)(s|m|h|d)$/.exec(str.trim());
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return num * mult;
}

function requireStaff(interaction, guildData) {
  if (!isStaff(interaction.member, guildData)) {
    interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

function requireAdmin(interaction, guildData) {
  if (!isAdmin(interaction.member, guildData)) {
    interaction.reply({ content: 'You need administrator permissions to use this command.', ephemeral: true });
    return false;
  }
  return true;
}

// ------------------------------------------------------------
// Anti-Nuke: action tracking + punishment
// ------------------------------------------------------------
function trackAction(guild, userId, actionType) {
  if (!client.nukeTracking.has(guild.id)) client.nukeTracking.set(guild.id, new Map());
  const guildMap = client.nukeTracking.get(guild.id);
  if (!guildMap.has(userId)) guildMap.set(userId, {});
  const userActions = guildMap.get(userId);
  if (!userActions[actionType]) userActions[actionType] = [];
  const now = Date.now();
  userActions[actionType].push(now);
  return userActions[actionType];
}

function pruneOld(timestamps, windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000;
  while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();
  return timestamps;
}

async function handleNukeAction(guild, actor, actionType) {
  const guildData = db.guild(guild.id);
  const antinuke = guildData.config.antinuke;
  if (!antinuke.enabled) return;
  if (!actor || actor.bot === undefined) return;

  const member = await guild.members.fetch(actor.id).catch(() => null);
  if (isWhitelisted(actor.id, member, guildData)) return;

  const threshold = antinuke.thresholds[actionType];
  if (!threshold) return;

  const timestamps = trackAction(guild, actor.id, actionType);
  pruneOld(timestamps, threshold.window);

  if (timestamps.length >= threshold.limit) {
    await punishNuker(guild, guildData, actor, actionType, timestamps.length);
    // reset tracking for this action after punishment
    timestamps.length = 0;
  }
}

async function punishNuker(guild, guildData, actor, actionType, count) {
  const punishment = guildData.config.antinuke.punishment;
  const embed = baseEmbed(COLOR_DANGER)
    .setTitle('🛡️ Anti-Nuke Triggered')
    .setDescription(`**User:** ${fmtUser(actor)}\n**Action:** \`${actionType}\`\n**Occurrences:** ${count}\n**Punishment:** \`${punishment}\``);
  await sendLog(guild, guildData, 'security', embed);

  const member = await guild.members.fetch(actor.id).catch(() => null);
  if (!member) return;

  try {
    if (punishment === 'ban') {
      await guild.members.ban(actor.id, { reason: `Anti-Nuke: ${actionType} threshold exceeded` });
    } else if (punishment === 'kick') {
      await member.kick(`Anti-Nuke: ${actionType} threshold exceeded`);
    } else if (punishment === 'strip_roles') {
      const rolesToRemove = member.roles.cache.filter(r => r.id !== guild.id);
      await member.roles.remove(rolesToRemove, `Anti-Nuke: ${actionType} threshold exceeded`);
    }
    newCase(guildData, { type: `antinuke_${punishment}`, userId: actor.id, moderatorId: client.user.id, reason: `Anti-Nuke: ${actionType} threshold exceeded (${count} actions)` });
  } catch (err) {
    console.error('[ANTINUKE] Failed to punish:', err.message);
  }
}

async function getAuditActor(guild, auditType, targetId = null) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    const entry = targetId
      ? logs.entries.find(e => e.target && e.target.id === targetId)
      : logs.entries.first();
    if (!entry) return null;
    // ignore stale entries (> 5s old)
    if (Date.now() - entry.createdTimestamp > 5000) return null;
    return entry.executor;
  } catch {
    return null;
  }
}


// ------------------------------------------------------------
// Anti-Nuke: Event Listeners
// ------------------------------------------------------------
client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  const actor = await getAuditActor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  if (actor && actor.id !== client.user.id) await handleNukeAction(channel.guild, actor, 'channelDelete');
  await logChannelEvent(channel.guild, 'Channel Deleted', channel, actor, COLOR_DANGER);
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  const actor = await getAuditActor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  if (actor && actor.id !== client.user.id) await handleNukeAction(channel.guild, actor, 'channelCreate');
  await logChannelEvent(channel.guild, 'Channel Created', channel, actor, COLOR_SUCCESS);
});

client.on('roleDelete', async (role) => {
  const actor = await getAuditActor(role.guild, AuditLogEvent.RoleDelete, role.id);
  if (actor && actor.id !== client.user.id) await handleNukeAction(role.guild, actor, 'roleDelete');
  const guildData = db.guild(role.guild.id);
  const embed = baseEmbed(COLOR_DANGER).setTitle('Role Deleted').setDescription(`**Role:** ${role.name}\n**By:** ${fmtUser(actor)}`);
  await sendLog(role.guild, guildData, 'log', embed);
});

client.on('roleCreate', async (role) => {
  const actor = await getAuditActor(role.guild, AuditLogEvent.RoleCreate, role.id);
  if (actor && actor.id !== client.user.id) await handleNukeAction(role.guild, actor, 'roleCreate');
  const guildData = db.guild(role.guild.id);
  const embed = baseEmbed(COLOR_SUCCESS).setTitle('Role Created').setDescription(`**Role:** ${role.name}\n**By:** ${fmtUser(actor)}`);
  await sendLog(role.guild, guildData, 'log', embed);
});

client.on('guildBanAdd', async (ban) => {
  const actor = await getAuditActor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (actor && actor.id !== client.user.id) await handleNukeAction(ban.guild, actor, 'ban');
  const guildData = db.guild(ban.guild.id);
  const embed = baseEmbed(COLOR_DANGER).setTitle('Member Banned').setDescription(`**User:** ${fmtUser(ban.user)}\n**By:** ${fmtUser(actor)}`);
  await sendLog(ban.guild, guildData, 'mod', embed);
});

client.on('guildBanRemove', async (ban) => {
  const actor = await getAuditActor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
  const guildData = db.guild(ban.guild.id);
  const embed = baseEmbed(COLOR_SUCCESS).setTitle('Member Unbanned').setDescription(`**User:** ${fmtUser(ban.user)}\n**By:** ${fmtUser(actor)}`);
  await sendLog(ban.guild, guildData, 'mod', embed);
});

client.on('guildMemberRemove', async (member) => {
  // detect kicks via audit log
  const actor = await getAuditActor(member.guild, AuditLogEvent.MemberKick, member.id);
  const guildData = db.guild(member.guild.id);
  if (actor && actor.id !== client.user.id) {
    await handleNukeAction(member.guild, actor, 'kick');
    const embed = baseEmbed(COLOR_DANGER).setTitle('Member Kicked').setDescription(`**User:** ${fmtUser(member.user)}\n**By:** ${fmtUser(actor)}`);
    await sendLog(member.guild, guildData, 'mod', embed);
  } else {
    // regular leave
    const embed = baseEmbed(COLOR).setTitle('Member Left').setDescription(`**User:** ${fmtUser(member.user)}\n**Member count:** ${member.guild.memberCount}`);
    await sendLog(member.guild, guildData, 'log', embed);
    if (guildData.config.goodbye.enabled && guildData.config.goodbye.channel) {
      const ch = await member.guild.channels.fetch(guildData.config.goodbye.channel).catch(() => null);
      if (ch) {
        const msg = guildData.config.goodbye.message
          .replace('{user}', member.user.tag)
          .replace('{server}', member.guild.name)
          .replace('{count}', member.guild.memberCount);
        ch.send(msg).catch(() => {});
      }
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  const guildData = db.guild(member.guild.id);

  // Anti-bot: kick unauthorized bots joining
  if (member.user.bot && guildData.config.antinuke.antiBot && guildData.config.antinuke.enabled) {
    if (!guildData.config.antinuke.antiBotWhitelist.includes(member.id)) {
      const actor = await getAuditActor(member.guild, AuditLogEvent.BotAdd, member.id);
      if (!actor || !isWhitelisted(actor.id, null, guildData)) {
        await member.kick('Anti-Nuke: unauthorized bot addition').catch(() => {});
        const embed = baseEmbed(COLOR_DANGER).setTitle('🛡️ Unauthorized Bot Removed').setDescription(`**Bot:** ${fmtUser(member.user)}\n**Added by:** ${fmtUser(actor)}`);
        await sendLog(member.guild, guildData, 'security', embed);
        if (actor) await handleNukeAction(member.guild, actor, 'ban');
        return;
      }
    }
  }

  const embed = baseEmbed(COLOR_SUCCESS).setTitle('Member Joined').setDescription(`**User:** ${fmtUser(member.user)}\n**Account created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n**Member count:** ${member.guild.memberCount}`);
  await sendLog(member.guild, guildData, 'log', embed);

  if (guildData.config.welcome.enabled && guildData.config.welcome.channel) {
    const ch = await member.guild.channels.fetch(guildData.config.welcome.channel).catch(() => null);
    if (ch) {
      const msg = guildData.config.welcome.message
        .replace('{user}', `<@${member.id}>`)
        .replace('{server}', member.guild.name)
        .replace('{count}', member.guild.memberCount);
      ch.send(msg).catch(() => {});
    }
  }
});

client.on('webhooksUpdate', async (channel) => {
  const actor = await getAuditActor(channel.guild, AuditLogEvent.WebhookCreate);
  if (actor && actor.id !== client.user.id) await handleNukeAction(channel.guild, actor, 'webhookCreate');
});

client.on('roleUpdate', async (oldRole, newRole) => {
  const permsChanged = !oldRole.permissions.equals(newRole.permissions);
  if (!permsChanged) return;
  const actor = await getAuditActor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  const guildData = db.guild(newRole.guild.id);
  const embed = baseEmbed(COLOR_WARN).setTitle('Role Permissions Updated').setDescription(`**Role:** ${newRole.name}\n**By:** ${fmtUser(actor)}`);
  await sendLog(newRole.guild, guildData, 'security', embed);
  if (actor && (newRole.permissions.has(PermissionFlagsBits.Administrator))) {
    await handleNukeAction(newRole.guild, actor, 'roleCreate'); // treat dangerous perm grant like role creation risk
  }
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  const actor = await getAuditActor(newGuild, AuditLogEvent.GuildUpdate);
  const guildData = db.guild(newGuild.id);
  const embed = baseEmbed(COLOR_WARN).setTitle('Server Settings Changed').setDescription(`**By:** ${fmtUser(actor)}`);
  await sendLog(newGuild, guildData, 'security', embed);
});

async function logChannelEvent(guild, title, channel, actor, color) {
  const guildData = db.guild(guild.id);
  const embed = baseEmbed(color).setTitle(title).setDescription(`**Channel:** ${channel.name || channel.id}\n**By:** ${fmtUser(actor)}`);
  await sendLog(guild, guildData, 'log', embed);
}

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  const permsChanged = JSON.stringify(oldChannel.permissionOverwrites?.cache?.map(p => p.id)) !== JSON.stringify(newChannel.permissionOverwrites?.cache?.map(p => p.id));
  if (!permsChanged) return;
  const actor = await getAuditActor(newChannel.guild, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id);
  const guildData = db.guild(newChannel.guild.id);
  const embed = baseEmbed(COLOR_WARN).setTitle('Channel Permissions Changed').setDescription(`**Channel:** ${newChannel.name}\n**By:** ${fmtUser(actor)}`);
  await sendLog(newChannel.guild, guildData, 'security', embed);
});


// ------------------------------------------------------------
// General Logging: messages, nicknames, timeouts, voice
// ------------------------------------------------------------
client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  const guildData = db.guild(message.guild.id);
  const embed = baseEmbed(COLOR_DANGER)
    .setTitle('Message Deleted')
    .setDescription(`**Author:** ${fmtUser(message.author)}\n**Channel:** <#${message.channel.id}>`)
    .addFields({ name: 'Content', value: message.content?.slice(0, 1000) || '*(no text content)*' });
  await sendLog(message.guild, guildData, 'log', embed);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  const guildData = db.guild(newMessage.guild.id);
  const embed = baseEmbed(COLOR_WARN)
    .setTitle('Message Edited')
    .setDescription(`**Author:** ${fmtUser(newMessage.author)}\n**Channel:** <#${newMessage.channel.id}> [Jump](${newMessage.url})`)
    .addFields(
      { name: 'Before', value: oldMessage.content?.slice(0, 500) || '*(empty)*' },
      { name: 'After', value: newMessage.content?.slice(0, 500) || '*(empty)*' },
    );
  await sendLog(newMessage.guild, guildData, 'log', embed);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const guildData = db.guild(newMember.guild.id);

  // nickname change
  if (oldMember.nickname !== newMember.nickname) {
    const embed = baseEmbed(COLOR).setTitle('Nickname Changed').setDescription(`**User:** ${fmtUser(newMember.user)}\n**Before:** ${oldMember.nickname || '*(none)*'}\n**After:** ${newMember.nickname || '*(none)*'}`);
    await sendLog(newMember.guild, guildData, 'log', embed);
  }

  // timeout applied/removed
  const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
  const newTimeout = newMember.communicationDisabledUntilTimestamp;
  if (oldTimeout !== newTimeout) {
    const actor = await getAuditActor(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    if (newTimeout && newTimeout > Date.now()) {
      const embed = baseEmbed(COLOR_WARN).setTitle('Member Timed Out').setDescription(`**User:** ${fmtUser(newMember.user)}\n**By:** ${fmtUser(actor)}\n**Until:** <t:${Math.floor(newTimeout / 1000)}:F>`);
      await sendLog(newMember.guild, guildData, 'mod', embed);
    } else if (!newTimeout && oldTimeout) {
      const embed = baseEmbed(COLOR_SUCCESS).setTitle('Timeout Removed').setDescription(`**User:** ${fmtUser(newMember.user)}\n**By:** ${fmtUser(actor)}`);
      await sendLog(newMember.guild, guildData, 'mod', embed);
    }
  }

  // role changes
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const added = [...newRoles].filter(r => !oldRoles.has(r));
  const removed = [...oldRoles].filter(r => !newRoles.has(r));
  if (added.length || removed.length) {
    const parts = [];
    if (added.length) parts.push(`**Added:** ${added.map(r => `<@&${r}>`).join(', ')}`);
    if (removed.length) parts.push(`**Removed:** ${removed.map(r => `<@&${r}>`).join(', ')}`);
    const embed = baseEmbed(COLOR).setTitle('Member Roles Updated').setDescription(`**User:** ${fmtUser(newMember.user)}\n${parts.join('\n')}`);
    await sendLog(newMember.guild, guildData, 'log', embed);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const guildData = db.guild(guild.id);
  const member = newState.member || oldState.member;
  let title = null;
  let desc = null;
  if (!oldState.channelId && newState.channelId) {
    title = 'Voice Channel Joined';
    desc = `**User:** ${fmtUser(member.user)}\n**Channel:** <#${newState.channelId}>`;
  } else if (oldState.channelId && !newState.channelId) {
    title = 'Voice Channel Left';
    desc = `**User:** ${fmtUser(member.user)}\n**Channel:** <#${oldState.channelId}>`;
  } else if (oldState.channelId !== newState.channelId) {
    title = 'Voice Channel Switched';
    desc = `**User:** ${fmtUser(member.user)}\n**From:** <#${oldState.channelId}>\n**To:** <#${newState.channelId}>`;
  }
  if (title) {
    const embed = baseEmbed(COLOR).setTitle(title).setDescription(desc);
    await sendLog(guild, guildData, 'log', embed);
  }
});


// ------------------------------------------------------------
// AFK + Leveling: messageCreate
// ------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const guildData = db.guild(message.guild.id);

  // --- AFK: clear own AFK status ---
  if (guildData.afk[message.author.id]) {
    delete guildData.afk[message.author.id];
    db.save();
    message.reply({ content: `Welcome back, ${message.author}. I've removed your AFK status.` })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 5000))
      .catch(() => {});
  }

  // --- AFK: notify if mentioning AFK users ---
  if (message.mentions.users.size) {
    const afkMentions = [];
    for (const [, user] of message.mentions.users) {
      const afk = guildData.afk[user.id];
      if (afk) {
        const since = `<t:${Math.floor(afk.since / 1000)}:R>`;
        afkMentions.push(`**${user.username}** is AFK: ${afk.reason} (${since})`);
      }
    }
    if (afkMentions.length) {
      message.reply({ content: afkMentions.join('\n') }).catch(() => {});
    }
  }

  // --- Leveling / XP ---
  if (guildData.config.levels.enabled) {
    if (!guildData.levels[message.author.id]) guildData.levels[message.author.id] = { xp: 0, level: 0, lastMessage: 0 };
    const userLevel = guildData.levels[message.author.id];
    const cooldownMs = guildData.config.levels.cooldownSeconds * 1000;
    if (Date.now() - userLevel.lastMessage > cooldownMs) {
      const { xpMin, xpMax } = guildData.config.levels;
      const gained = Math.floor(Math.random() * (xpMax - xpMin + 1)) + xpMin;
      userLevel.xp += gained;
      userLevel.lastMessage = Date.now();
      const xpNeeded = 5 * (userLevel.level ** 2) + 50 * userLevel.level + 100;
      if (userLevel.xp >= xpNeeded) {
        userLevel.xp -= xpNeeded;
        userLevel.level += 1;
        const announceId = guildData.config.levels.announceChannel || message.channel.id;
        const ch = await message.guild.channels.fetch(announceId).catch(() => null);
        if (ch) {
          const embed = baseEmbed(COLOR_SUCCESS).setTitle('🎉 Level Up!').setDescription(`${message.author} reached **Level ${userLevel.level}**!`);
          ch.send({ embeds: [embed] }).catch(() => {});
        }
      }
      db.save();
    }
  }

  // --- Lightweight prefix commands (mirrors of the most common slash commands) ---
  const prefix = guildData.config.prefix || '!';
  if (message.content.startsWith(prefix)) {
    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();
    if (cmd === 'help') {
      await message.reply({ embeds: [buildHelpEmbed(guildData)] }).catch(() => {});
    } else if (cmd === 'ping') {
      await message.reply(`🏓 Pong! Latency: ${Date.now() - message.createdTimestamp}ms | API: ${Math.round(client.ws.ping)}ms`).catch(() => {});
    } else if (cmd === 'afk') {
      const reason = args.join(' ') || 'AFK';
      guildData.afk[message.author.id] = { reason, since: Date.now() };
      db.save();
      await message.reply(`You are now AFK: ${reason}`).catch(() => {});
    }
    // Everything else (moderation, tickets, config, etc.) is slash-command only by
    // design, so permissions and input validation stay consistent in one place.
  }
});


// ------------------------------------------------------------
// Help embed builder
// ------------------------------------------------------------
function buildHelpEmbed(guildData) {
  const prefix = guildData.config.prefix || '!';
  return baseEmbed(COLOR)
    .setTitle('📖 Command Help')
    .setDescription(`Most commands are slash commands — type \`/\` to see them with autocomplete and descriptions.\nA few core utility commands also work with the prefix \`${prefix}\` (${prefix}help, ${prefix}ping, ${prefix}afk).`)
    .addFields(
      { name: '🛡️ Security', value: '`/antinuke` `/lockdown` `/whitelist` `/unwhitelist`', inline: false },
      { name: '🔨 Moderation', value: '`/warn` `/unwarn` `/warnings` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/softban` `/purge` `/slowmode` `/lock` `/unlock` `/nickname` `/case`', inline: false },
      { name: '🎫 Tickets', value: '`/ticket-panel` `/ticket-add` `/ticket-remove` `/ticket-close`', inline: false },
      { name: '💤 AFK', value: '`/afk`', inline: false },
      { name: '📈 Levels', value: '`/rank` `/leaderboard`', inline: false },
      { name: '🎭 Roles', value: '`/reactionrole-add`', inline: false },
      { name: 'ℹ️ Utility', value: '`/userinfo` `/serverinfo` `/avatar` `/ping` `/help`', inline: false },
      { name: '⚙️ Setup', value: '`/setup quick` (one command, auto-creates everything) or `/setup logchannel` `/setup staffrole` `/setup welcome` `/setup goodbye` `/setup levels` `/setup tickets` `/prefix`', inline: false },
    )
    .setFooter({ text: 'Staff-only commands are hidden from members without permission.' });
}

// ------------------------------------------------------------
// Slash Command Definitions
// ------------------------------------------------------------
const commands = [
  // ---------- Utility ----------
  new SlashCommandBuilder().setName('ping').setDescription('Check the bot\'s latency.'),
  new SlashCommandBuilder().setName('help').setDescription('Show a list of available commands.'),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show information about a user.')
    .addUserOption(o => o.setName('user').setDescription('The user to look up').setRequired(false)),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Show information about this server.'),
  new SlashCommandBuilder().setName('avatar').setDescription('Show a user\'s avatar.')
    .addUserOption(o => o.setName('user').setDescription('The user to look up').setRequired(false)),
  new SlashCommandBuilder().setName('prefix').setDescription('View or change the server\'s text-command prefix.')
    .addStringOption(o => o.setName('new_prefix').setDescription('The new prefix (e.g. !)').setRequired(false)),

  // ---------- AFK ----------
  new SlashCommandBuilder().setName('afk').setDescription('Set yourself as AFK.')
    .addStringOption(o => o.setName('reason').setDescription('Reason for being AFK').setRequired(false)),

  // ---------- Moderation ----------
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member.')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(false)),
  new SlashCommandBuilder().setName('unwarn').setDescription('Remove a warning from a member.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('warning_id').setDescription('Warning ID to remove').setRequired(true)),
  new SlashCommandBuilder().setName('warnings').setDescription('View a member\'s warning history.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member.')
    .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 1h, 1d').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
  new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member\'s timeout.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member.')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a user.')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setRequired(false)),
  new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID.')
    .addStringOption(o => o.setName('user_id').setDescription('User ID to unban').setRequired(true)),
  new SlashCommandBuilder().setName('softban').setDescription('Ban then immediately unban a user (purges recent messages).')
    .addUserOption(o => o.setName('user').setDescription('User to softban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
  new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages.')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages (1-100)').setRequired(true))
    .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user').setRequired(false)),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode for this channel.')
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds (0 to disable)').setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('Lock the current channel.'),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock the current channel.'),
  new SlashCommandBuilder().setName('nickname').setDescription('Change a member\'s nickname.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('nickname').setDescription('New nickname (leave blank to reset)').setRequired(false)),
  new SlashCommandBuilder().setName('case').setDescription('Look up a moderation case by ID.')
    .addIntegerOption(o => o.setName('id').setDescription('Case ID').setRequired(true)),

  // ---------- Anti-Nuke / Security ----------
  new SlashCommandBuilder().setName('antinuke').setDescription('Configure the anti-nuke system.')
    .addSubcommand(sc => sc.setName('toggle').setDescription('Enable or disable anti-nuke').addBooleanOption(o => o.setName('enabled').setDescription('Enabled?').setRequired(true)))
    .addSubcommand(sc => sc.setName('punishment').setDescription('Set the punishment for triggering anti-nuke')
      .addStringOption(o => o.setName('type').setDescription('Punishment type').setRequired(true).addChoices({ name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Strip Roles', value: 'strip_roles' })))
    .addSubcommand(sc => sc.setName('threshold').setDescription('Set a threshold for an action type')
      .addStringOption(o => o.setName('action').setDescription('Action type').setRequired(true).addChoices(
        { name: 'Channel Delete', value: 'channelDelete' }, { name: 'Channel Create', value: 'channelCreate' },
        { name: 'Role Delete', value: 'roleDelete' }, { name: 'Role Create', value: 'roleCreate' },
        { name: 'Ban', value: 'ban' }, { name: 'Kick', value: 'kick' }, { name: 'Webhook Create', value: 'webhookCreate' }))
      .addIntegerOption(o => o.setName('limit').setDescription('Max occurrences').setRequired(true))
      .addIntegerOption(o => o.setName('window').setDescription('Time window in seconds').setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('View current anti-nuke configuration')),
  new SlashCommandBuilder().setName('lockdown').setDescription('Emergency-lock all channels in the server.')
    .addSubcommand(sc => sc.setName('start').setDescription('Start emergency lockdown'))
    .addSubcommand(sc => sc.setName('end').setDescription('End emergency lockdown')),
  new SlashCommandBuilder().setName('whitelist').setDescription('Whitelist a user from anti-nuke (protects them from auto-kick/ban). Leave user blank to view the list.')
    .addUserOption(o => o.setName('user').setDescription('User to whitelist').setRequired(false)),
  new SlashCommandBuilder().setName('unwhitelist').setDescription('Remove a user from the anti-nuke whitelist.')
    .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)),

  // ---------- Tickets ----------
  new SlashCommandBuilder().setName('ticket-panel').setDescription('Post the ticket creation panel in this channel.'),
  new SlashCommandBuilder().setName('ticket-add').setDescription('Add a member to the current ticket.')
    .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-remove').setDescription('Remove a member from the current ticket.')
    .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)),
  new SlashCommandBuilder().setName('ticket-close').setDescription('Close the current ticket.')
    .addStringOption(o => o.setName('reason').setDescription('Close reason').setRequired(false)),

  // ---------- Reaction Roles ----------
  new SlashCommandBuilder().setName('reactionrole-add').setDescription('Add a self-assignable role button to a message you specify.')
    .addStringOption(o => o.setName('message_id').setDescription('The message ID to attach the button to').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to grant').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Button label').setRequired(true)),

  // ---------- Leveling ----------
  new SlashCommandBuilder().setName('rank').setDescription('Check your (or someone else\'s) level and XP.')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the server XP leaderboard.'),

  // ---------- Setup / Configuration ----------
  // Every channel/role option below is OPTIONAL. If you don't pick one, the bot
  // creates it for you (under a "Bot Management" category, or a sensibly-named
  // role) so you never have to type out a channel name yourself.
  new SlashCommandBuilder().setName('setup').setDescription('Set up or configure the bot for this server.')
    .addSubcommand(sc => sc.setName('quick').setDescription('One-command full setup: creates all channels/roles and enables everything with sensible defaults.'))
    .addSubcommand(sc => sc.setName('logchannel').setDescription('Set (or auto-create) the general log channel').addChannelOption(o => o.setName('channel').setDescription('Leave blank to auto-create').setRequired(false)))
    .addSubcommand(sc => sc.setName('modlogchannel').setDescription('Set (or auto-create) the moderation log channel').addChannelOption(o => o.setName('channel').setDescription('Leave blank to auto-create').setRequired(false)))
    .addSubcommand(sc => sc.setName('securitylogchannel').setDescription('Set (or auto-create) the security log channel').addChannelOption(o => o.setName('channel').setDescription('Leave blank to auto-create').setRequired(false)))
    .addSubcommand(sc => sc.setName('staffrole').setDescription('Set (or auto-create) the staff role').addRoleOption(o => o.setName('role').setDescription('Leave blank to auto-create "Staff"').setRequired(false)))
    .addSubcommand(sc => sc.setName('adminrole').setDescription('Set (or auto-create) the admin role').addRoleOption(o => o.setName('role').setDescription('Leave blank to auto-create "Admin"').setRequired(false)))
    .addSubcommand(sc => sc.setName('welcome').setDescription('Enable welcome messages (auto-creates the channel if you skip it)')
      .addChannelOption(o => o.setName('channel').setDescription('Leave blank to auto-create').setRequired(false))
      .addStringOption(o => o.setName('message').setDescription('Use {user}, {server}, {count}').setRequired(false)))
    .addSubcommand(sc => sc.setName('goodbye').setDescription('Enable goodbye messages (auto-creates the channel if you skip it)')
      .addChannelOption(o => o.setName('channel').setDescription('Leave blank to auto-create').setRequired(false))
      .addStringOption(o => o.setName('message').setDescription('Use {user}, {server}, {count}').setRequired(false)))
    .addSubcommand(sc => sc.setName('levels').setDescription('Enable/disable the leveling system').addBooleanOption(o => o.setName('enabled').setDescription('Enabled?').setRequired(true)))
    .addSubcommand(sc => sc.setName('tickets').setDescription('Set up the ticket system (auto-creates anything you skip)')
      .addChannelOption(o => o.setName('panel_channel').setDescription('Leave blank to auto-create').setRequired(false))
      .addChannelOption(o => o.setName('transcript_channel').setDescription('Leave blank to auto-create').setRequired(false))
      .addRoleOption(o => o.setName('staff_role').setDescription('Leave blank to auto-create "Support"').setRequired(false))),
].map(c => c.toJSON());


// ------------------------------------------------------------
// Command Registration
// ------------------------------------------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`[COMMANDS] Registered ${commands.length} guild commands instantly to guild ${GUILD_ID}.`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log(`[COMMANDS] Registered ${commands.length} global commands (may take up to 1 hour to appear everywhere).`);
    }
  } catch (err) {
    console.error('[COMMANDS] Failed to register commands:', err);
  }
}

// ------------------------------------------------------------
// Interaction Handler
// ------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return handleSlashCommand(interaction);
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isStringSelectMenu()) return handleSelectMenu(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
  } catch (err) {
    console.error(`[INTERACTION ERROR] ${interaction.commandName || interaction.customId}:`, err);
    const payload = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      interaction.followUp(payload).catch(() => {});
    } else {
      interaction.reply(payload).catch(() => {});
    }
  }
});

async function handleSlashCommand(interaction) {
  const { commandName, guild } = interaction;
  if (!guild) return interaction.reply({ content: 'This bot only works inside servers.', ephemeral: true });
  const guildData = db.guild(guild.id);

  switch (commandName) {
    // ---------------- Utility ----------------
    case 'ping': {
      const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
      const latency = sent.createdTimestamp - interaction.createdTimestamp;
      await interaction.editReply(`🏓 Pong! Latency: ${latency}ms | API: ${Math.round(client.ws.ping)}ms`);
      break;
    }
    case 'help': {
      await interaction.reply({ embeds: [buildHelpEmbed(guildData)] });
      break;
    }
    case 'userinfo': {
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await guild.members.fetch(user.id).catch(() => null);
      const embed = baseEmbed(COLOR).setTitle(`User Info — ${user.tag}`).setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'ID', value: user.id, inline: true },
          { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
          { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        );
      if (member) {
        embed.addFields(
          { name: 'Joined Server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Nickname', value: member.nickname || '*(none)*', inline: true },
          { name: 'Roles', value: member.roles.cache.filter(r => r.id !== guild.id).map(r => `<@&${r.id}>`).join(', ') || '*(none)*', inline: false },
        );
      }
      await interaction.reply({ embeds: [embed] });
      break;
    }
    case 'serverinfo': {
      const embed = baseEmbed(COLOR).setTitle(guild.name).setThumbnail(guild.iconURL())
        .addFields(
          { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
          { name: 'Members', value: `${guild.memberCount}`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
          { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
          { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true },
        );
      await interaction.reply({ embeds: [embed] });
      break;
    }
    case 'avatar': {
      const user = interaction.options.getUser('user') || interaction.user;
      const embed = baseEmbed(COLOR).setTitle(`${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 1024 }));
      await interaction.reply({ embeds: [embed] });
      break;
    }
    case 'prefix': {
      const newPrefix = interaction.options.getString('new_prefix');
      if (!newPrefix) {
        await interaction.reply({ content: `The current prefix is \`${guildData.config.prefix}\`.`, ephemeral: true });
        break;
      }
      if (!requireAdmin(interaction, guildData)) break;
      if (newPrefix.length > 5) {
        await interaction.reply({ content: 'Prefix must be 5 characters or fewer.', ephemeral: true });
        break;
      }
      guildData.config.prefix = newPrefix;
      db.save();
      await interaction.reply({ content: `Prefix updated to \`${newPrefix}\`.` });
      break;
    }

    // ---------------- AFK ----------------
    case 'afk': {
      const reason = interaction.options.getString('reason') || 'AFK';
      guildData.afk[interaction.user.id] = { reason, since: Date.now() };
      db.save();
      await interaction.reply(`You are now AFK: ${reason}`);
      break;
    }

    default:
      return handleModerationOrConfigCommand(interaction, guildData);
  }
}


async function handleModerationOrConfigCommand(interaction, guildData) {
  const { commandName, guild, member: invokingMember } = interaction;

  // ---------------- Moderation ----------------
  const modCommands = ['warn', 'unwarn', 'warnings', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'softban', 'purge', 'slowmode', 'lock', 'unlock', 'nickname', 'case'];
  if (modCommands.includes(commandName)) {
    if (!requireStaff(interaction, guildData)) return;

    switch (commandName) {
      case 'warn': {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const warning = addWarning(guildData, user.id, interaction.user.id, reason);
        newCase(guildData, { type: 'warn', userId: user.id, moderatorId: interaction.user.id, reason });
        const embed = baseEmbed(COLOR_WARN).setTitle('Member Warned').setDescription(`**User:** ${fmtUser(user)}\n**Reason:** ${reason}\n**Warning ID:** ${warning.id}`);
        await interaction.reply({ embeds: [embed] });
        await sendLog(guild, guildData, 'mod', embed);
        user.send(`You were warned in **${guild.name}**: ${reason}`).catch(() => {});
        break;
      }
      case 'unwarn': {
        const user = interaction.options.getUser('user');
        const warningId = interaction.options.getInteger('warning_id');
        const list = guildData.warnings[user.id] || [];
        const idx = list.findIndex(w => w.id === warningId);
        if (idx === -1) {
          await interaction.reply({ content: 'Warning not found.', ephemeral: true });
          break;
        }
        list.splice(idx, 1);
        db.save();
        await interaction.reply({ content: `Removed warning #${warningId} from ${fmtUser(user)}.` });
        break;
      }
      case 'warnings': {
        const user = interaction.options.getUser('user');
        const list = guildData.warnings[user.id] || [];
        const embed = baseEmbed(COLOR).setTitle(`Warnings — ${user.tag}`);
        if (!list.length) embed.setDescription('No warnings on record.');
        else embed.setDescription(list.map(w => `**#${w.id}** — ${w.reason} (by <@${w.moderatorId}>, <t:${Math.floor(w.timestamp / 1000)}:R>)`).join('\n'));
        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'timeout': {
        const user = interaction.options.getUser('user');
        const durationStr = interaction.options.getString('duration');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const ms = parseDuration(durationStr);
        if (!ms || ms > 28 * 86400000) {
          await interaction.reply({ content: 'Invalid duration. Use formats like 10m, 1h, 1d (max 28d).', ephemeral: true });
          break;
        }
        const targetMember = await guild.members.fetch(user.id).catch(() => null);
        if (!targetMember) { await interaction.reply({ content: 'User not found in this server.', ephemeral: true }); break; }
        await targetMember.timeout(ms, reason);
        newCase(guildData, { type: 'timeout', userId: user.id, moderatorId: interaction.user.id, reason });
        const embed = baseEmbed(COLOR_WARN).setTitle('Member Timed Out').setDescription(`**User:** ${fmtUser(user)}\n**Duration:** ${durationStr}\n**Reason:** ${reason}`);
        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'untimeout': {
        const user = interaction.options.getUser('user');
        const targetMember = await guild.members.fetch(user.id).catch(() => null);
        if (!targetMember) { await interaction.reply({ content: 'User not found in this server.', ephemeral: true }); break; }
        await targetMember.timeout(null);
        await interaction.reply({ content: `Removed timeout for ${fmtUser(user)}.` });
        break;
      }
      case 'kick': {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const targetMember = await guild.members.fetch(user.id).catch(() => null);
        if (!targetMember) { await interaction.reply({ content: 'User not found in this server.', ephemeral: true }); break; }
        if (!targetMember.kickable) { await interaction.reply({ content: 'I cannot kick this member (role hierarchy).', ephemeral: true }); break; }
        await targetMember.kick(reason);
        newCase(guildData, { type: 'kick', userId: user.id, moderatorId: interaction.user.id, reason });
        const embed = baseEmbed(COLOR_DANGER).setTitle('Member Kicked').setDescription(`**User:** ${fmtUser(user)}\n**Reason:** ${reason}`);
        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'ban': {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days') || 0;
        try {
          await guild.members.ban(user.id, { reason, deleteMessageSeconds: Math.min(Math.max(deleteDays, 0), 7) * 86400 });
        } catch {
          await interaction.reply({ content: 'I could not ban this user (role hierarchy or permissions).', ephemeral: true });
          break;
        }
        newCase(guildData, { type: 'ban', userId: user.id, moderatorId: interaction.user.id, reason });
        const embed = baseEmbed(COLOR_DANGER).setTitle('Member Banned').setDescription(`**User:** ${fmtUser(user)}\n**Reason:** ${reason}`);
        await interaction.reply({ embeds: [embed] });
        break;
      }
      case 'unban': {
        const userId = interaction.options.getString('user_id');
        try {
          await guild.members.unban(userId);
        } catch {
          await interaction.reply({ content: 'Could not unban that ID (not banned, or invalid ID).', ephemeral: true });
          break;
        }
        newCase(guildData, { type: 'unban', userId, moderatorId: interaction.user.id, reason: 'Manual unban' });
        await interaction.reply({ content: `Unbanned <@${userId}>.` });
        break;
      }
      case 'softban': {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        try {
          await guild.members.ban(user.id, { reason: `Softban: ${reason}`, deleteMessageSeconds: 86400 });
          await guild.members.unban(user.id, 'Softban cleanup');
        } catch {
          await interaction.reply({ content: 'Could not softban this user.', ephemeral: true });
          break;
        }
        newCase(guildData, { type: 'softban', userId: user.id, moderatorId: interaction.user.id, reason });
        await interaction.reply({ content: `Softbanned ${fmtUser(user)} (recent messages purged).` });
        break;
      }
      case 'purge': {
        const amount = interaction.options.getInteger('amount');
        const targetUser = interaction.options.getUser('user');
        if (amount < 1 || amount > 100) { await interaction.reply({ content: 'Amount must be between 1 and 100.', ephemeral: true }); break; }
        await interaction.deferReply({ ephemeral: true });
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        let toDelete = messages;
        if (targetUser) toDelete = messages.filter(m => m.author.id === targetUser.id);
        toDelete = [...toDelete.values()].slice(0, amount);
        await interaction.channel.bulkDelete(toDelete, true).catch(() => {});
        await interaction.editReply(`Deleted ${toDelete.length} messages.`);
        break;
      }
      case 'slowmode': {
        const seconds = interaction.options.getInteger('seconds');
        await interaction.channel.setRateLimitPerUser(Math.min(Math.max(seconds, 0), 21600));
        await interaction.reply(seconds === 0 ? 'Slowmode disabled.' : `Slowmode set to ${seconds}s.`);
        break;
      }
      case 'lock': {
        await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        await interaction.reply('🔒 Channel locked.');
        break;
      }
      case 'unlock': {
        await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
        await interaction.reply('🔓 Channel unlocked.');
        break;
      }
      case 'nickname': {
        const user = interaction.options.getUser('user');
        const nickname = interaction.options.getString('nickname');
        const targetMember = await guild.members.fetch(user.id).catch(() => null);
        if (!targetMember) { await interaction.reply({ content: 'User not found in this server.', ephemeral: true }); break; }
        await targetMember.setNickname(nickname || null).catch(() => {});
        await interaction.reply(`Updated nickname for ${fmtUser(user)}.`);
        break;
      }
      case 'case': {
        const id = interaction.options.getInteger('id');
        const c = guildData.cases.find(c => c.id === id);
        if (!c) { await interaction.reply({ content: 'Case not found.', ephemeral: true }); break; }
        const embed = baseEmbed(COLOR).setTitle(`Case #${c.id}`).addFields(
          { name: 'Type', value: c.type, inline: true },
          { name: 'User', value: fmtUser(c.userId), inline: true },
          { name: 'Moderator', value: fmtUser(c.moderatorId), inline: true },
          { name: 'Reason', value: c.reason, inline: false },
          { name: 'Date', value: `<t:${Math.floor(c.timestamp / 1000)}:F>`, inline: false },
        );
        await interaction.reply({ embeds: [embed] });
        break;
      }
    }
    return;
  }

  // ---------------- Anti-Nuke ----------------
  if (commandName === 'antinuke') {
    if (!requireAdmin(interaction, guildData)) return;
    const sub = interaction.options.getSubcommand();
    const antinuke = guildData.config.antinuke;
    if (sub === 'toggle') {
      antinuke.enabled = interaction.options.getBoolean('enabled');
      db.save();
      await interaction.reply(`Anti-Nuke is now **${antinuke.enabled ? 'enabled' : 'disabled'}**.`);
    } else if (sub === 'punishment') {
      antinuke.punishment = interaction.options.getString('type');
      db.save();
      await interaction.reply(`Anti-Nuke punishment set to **${antinuke.punishment}**.`);
    } else if (sub === 'threshold') {
      const action = interaction.options.getString('action');
      const limit = interaction.options.getInteger('limit');
      const window = interaction.options.getInteger('window');
      antinuke.thresholds[action] = { limit, window };
      db.save();
      await interaction.reply(`Threshold for \`${action}\` set to ${limit} actions per ${window}s.`);
    } else if (sub === 'status') {
      const embed = baseEmbed(COLOR).setTitle('Anti-Nuke Configuration')
        .setDescription(`**Enabled:** ${antinuke.enabled}\n**Punishment:** ${antinuke.punishment}\n**Anti-Bot:** ${antinuke.antiBot}`)
        .addFields(Object.entries(antinuke.thresholds).map(([k, v]) => ({ name: k, value: `${v.limit} / ${v.window}s`, inline: true })));
      await interaction.reply({ embeds: [embed] });
    }
    return;
  }

  if (commandName === 'lockdown') {
    if (!requireAdmin(interaction, guildData)) return;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();
    const channels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
    if (sub === 'start') {
      client.lockdownGuilds.add(guild.id);
      for (const [, ch] of channels) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
      const embed = baseEmbed(COLOR_DANGER).setTitle('🚨 Emergency Lockdown Activated').setDescription(`Locked ${channels.size} channels.`);
      await interaction.editReply({ embeds: [embed] });
      await sendLog(guild, guildData, 'security', embed);
    } else {
      client.lockdownGuilds.delete(guild.id);
      for (const [, ch] of channels) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
      }
      const embed = baseEmbed(COLOR_SUCCESS).setTitle('✅ Lockdown Lifted').setDescription(`Unlocked ${channels.size} channels.`);
      await interaction.editReply({ embeds: [embed] });
      await sendLog(guild, guildData, 'security', embed);
    }
    return;
  }

  if (commandName === 'whitelist') {
    if (!requireAdmin(interaction, guildData)) return;
    const antinuke = guildData.config.antinuke;
    const user = interaction.options.getUser('user');

    if (!user) {
      const embed = baseEmbed(COLOR).setTitle('Anti-Nuke Whitelist')
        .setDescription(antinuke.whitelistUsers.length ? antinuke.whitelistUsers.map(id => `<@${id}>`).join('\n') : 'No users whitelisted.');
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (!antinuke.whitelistUsers.includes(user.id)) antinuke.whitelistUsers.push(user.id);
    db.save();
    await interaction.reply(`✅ ${fmtUser(user)} is now whitelisted — anti-nuke will never auto-kick or auto-ban them, no matter what they trigger.`);
    return;
  }

  if (commandName === 'unwhitelist') {
    if (!requireAdmin(interaction, guildData)) return;
    const antinuke = guildData.config.antinuke;
    const user = interaction.options.getUser('user');
    antinuke.whitelistUsers = antinuke.whitelistUsers.filter(id => id !== user.id);
    db.save();
    await interaction.reply(`Removed ${fmtUser(user)} from the whitelist.`);
    return;
  }

  return handleTicketReactionRoleAndConfig(interaction, guildData);
}


async function handleTicketReactionRoleAndConfig(interaction, guildData) {
  const { commandName, guild } = interaction;

  // ---------------- Tickets ----------------
  if (commandName === 'ticket-panel') {
    if (!requireStaff(interaction, guildData)) return;
    const cfg = guildData.config.tickets;
    const embed = baseEmbed(COLOR).setTitle('🎫 Support Tickets').setDescription('Select a category below to open a ticket. Our staff team will assist you shortly.');
    const menu = new StringSelectMenuBuilder().setCustomId('ticket_category_select').setPlaceholder('Choose a ticket category')
      .addOptions(cfg.categories.map(c => ({ label: c.label, value: c.id, emoji: c.emoji })));
    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.channel.send({ embeds: [embed], components: [row] });
    cfg.panelChannel = interaction.channel.id;
    db.save();
    await interaction.reply({ content: 'Ticket panel posted.', ephemeral: true });
    return;
  }

  if (commandName === 'ticket-add' || commandName === 'ticket-remove') {
    const ticket = guildData.tickets[interaction.channel.id];
    if (!ticket) { await interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }); return; }
    if (!requireStaff(interaction, guildData)) return;
    const user = interaction.options.getUser('user');
    if (commandName === 'ticket-add') {
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true });
      await interaction.reply(`Added ${fmtUser(user)} to this ticket.`);
    } else {
      await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: false });
      await interaction.reply(`Removed ${fmtUser(user)} from this ticket.`);
    }
    return;
  }

  if (commandName === 'ticket-close') {
    const ticket = guildData.tickets[interaction.channel.id];
    if (!ticket) { await interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true }); return; }
    if (!requireStaff(interaction, guildData)) return;
    const reason = interaction.options.getString('reason') || 'No reason provided';
    await closeTicket(interaction.channel, guildData, interaction.user, reason);
    return;
  }

  // ---------------- Reaction Roles ----------------
  if (commandName === 'reactionrole-add') {
    if (!requireStaff(interaction, guildData)) return;
    const messageId = interaction.options.getString('message_id');
    const role = interaction.options.getRole('role');
    const label = interaction.options.getString('label');
    const targetMessage = await interaction.channel.messages.fetch(messageId).catch(() => null);
    if (!targetMessage) { await interaction.reply({ content: 'Could not find that message in this channel.', ephemeral: true }); return; }

    if (!guildData.config.reactionRoles[messageId]) guildData.config.reactionRoles[messageId] = [];
    const customId = `rr_${role.id}_${Date.now()}`;
    guildData.config.reactionRoles[messageId].push({ roleId: role.id, customId });
    db.save();

    const existingRows = targetMessage.components.map(row => ActionRowBuilder.from(row));
    let row = existingRows[existingRows.length - 1];
    if (!row || row.components.length >= 5) {
      row = new ActionRowBuilder();
      existingRows.push(row);
    }
    row.addComponents(new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Secondary));
    await targetMessage.edit({ components: existingRows.slice(0, 5) });
    await interaction.reply({ content: `Added self-role button for <@&${role.id}> on that message.`, ephemeral: true });
    return;
  }

  // ---------------- Leveling ----------------
  if (commandName === 'rank') {
    const user = interaction.options.getUser('user') || interaction.user;
    const data = guildData.levels[user.id] || { xp: 0, level: 0 };
    const xpNeeded = 5 * (data.level ** 2) + 50 * data.level + 100;
    const embed = baseEmbed(COLOR).setTitle(`${user.username}'s Rank`)
      .addFields({ name: 'Level', value: `${data.level}`, inline: true }, { name: 'XP', value: `${data.xp} / ${xpNeeded}`, inline: true });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (commandName === 'leaderboard') {
    const entries = Object.entries(guildData.levels).sort((a, b) => (b[1].level - a[1].level) || (b[1].xp - a[1].xp)).slice(0, 10);
    if (!entries.length) { await interaction.reply('No XP data yet.'); return; }
    const desc = entries.map(([userId, d], i) => `**${i + 1}.** <@${userId}> — Level ${d.level} (${d.xp} XP)`).join('\n');
    const embed = baseEmbed(COLOR).setTitle('📈 XP Leaderboard').setDescription(desc);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  // ---------------- Setup ----------------
  if (commandName === 'setup') {
    if (!requireAdmin(interaction, guildData)) return;
    const sub = interaction.options.getSubcommand();
    const cfg = guildData.config;
    await interaction.deferReply();

    if (sub === 'quick') {
      const category = await getOrCreateSetupCategory(guild);
      const logCh = await findOrCreateChannel(guild, 'logs', category);
      const modLogCh = await findOrCreateChannel(guild, 'mod-logs', category);
      const secLogCh = await findOrCreateChannel(guild, 'security-logs', category);
      const welcomeCh = await findOrCreateChannel(guild, 'welcome', category);
      const ticketsCh = await findOrCreateChannel(guild, 'tickets', category);
      const transcriptCh = await findOrCreateChannel(guild, 'ticket-transcripts', category);
      const staffRole = await findOrCreateRole(guild, 'Staff', 0x5865f2);
      const adminRole = await findOrCreateRole(guild, 'Admin', 0xed4245);
      const supportRole = await findOrCreateRole(guild, 'Support', 0x57f287);

      cfg.logChannel = logCh.id;
      cfg.modLogChannel = modLogCh.id;
      cfg.securityLogChannel = secLogCh.id;
      cfg.welcome = { enabled: true, channel: welcomeCh.id, message: cfg.welcome.message };
      if (!cfg.staffRoles.includes(staffRole.id)) cfg.staffRoles.push(staffRole.id);
      if (!cfg.adminRoles.includes(adminRole.id)) cfg.adminRoles.push(adminRole.id);
      cfg.tickets.panelChannel = ticketsCh.id;
      cfg.tickets.transcriptChannel = transcriptCh.id;
      if (!cfg.tickets.staffRoles.includes(supportRole.id)) cfg.tickets.staffRoles.push(supportRole.id);
      cfg.tickets.enabled = true;
      db.save();

      await postTicketPanel(ticketsCh, cfg.tickets);

      const embed = baseEmbed(COLOR_SUCCESS).setTitle('✅ Quick Setup Complete')
        .setDescription('Created everything below with sensible defaults. Adjust anything anytime with the other `/setup` subcommands.')
        .addFields(
          { name: 'Channels', value: `${logCh} ${modLogCh} ${secLogCh} ${welcomeCh} ${ticketsCh} ${transcriptCh}` },
          { name: 'Roles', value: `${staffRole} ${adminRole} ${supportRole}\n*(assign these to your team — I don't know who your staff are)*` },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'logchannel') {
      const channel = interaction.options.getChannel('channel') || await findOrCreateChannel(guild, 'logs', await getOrCreateSetupCategory(guild));
      cfg.logChannel = channel.id;
      db.save();
      await interaction.editReply(`Log channel set to <#${cfg.logChannel}>.`);
    } else if (sub === 'modlogchannel') {
      const channel = interaction.options.getChannel('channel') || await findOrCreateChannel(guild, 'mod-logs', await getOrCreateSetupCategory(guild));
      cfg.modLogChannel = channel.id;
      db.save();
      await interaction.editReply(`Mod log channel set to <#${cfg.modLogChannel}>.`);
    } else if (sub === 'securitylogchannel') {
      const channel = interaction.options.getChannel('channel') || await findOrCreateChannel(guild, 'security-logs', await getOrCreateSetupCategory(guild));
      cfg.securityLogChannel = channel.id;
      db.save();
      await interaction.editReply(`Security log channel set to <#${cfg.securityLogChannel}>.`);
    } else if (sub === 'staffrole') {
      const role = interaction.options.getRole('role') || await findOrCreateRole(guild, 'Staff', 0x5865f2);
      if (!cfg.staffRoles.includes(role.id)) cfg.staffRoles.push(role.id);
      db.save();
      await interaction.editReply(`<@&${role.id}> is now a staff role.`);
    } else if (sub === 'adminrole') {
      const role = interaction.options.getRole('role') || await findOrCreateRole(guild, 'Admin', 0xed4245);
      if (!cfg.adminRoles.includes(role.id)) cfg.adminRoles.push(role.id);
      db.save();
      await interaction.editReply(`<@&${role.id}> is now an admin role.`);
    } else if (sub === 'welcome') {
      const channel = interaction.options.getChannel('channel') || await findOrCreateChannel(guild, 'welcome', await getOrCreateSetupCategory(guild));
      cfg.welcome.enabled = true;
      cfg.welcome.channel = channel.id;
      const msg = interaction.options.getString('message');
      if (msg) cfg.welcome.message = msg;
      db.save();
      await interaction.editReply(`Welcome messages enabled in <#${cfg.welcome.channel}>.`);
    } else if (sub === 'goodbye') {
      const channel = interaction.options.getChannel('channel') || await findOrCreateChannel(guild, 'goodbye', await getOrCreateSetupCategory(guild));
      cfg.goodbye.enabled = true;
      cfg.goodbye.channel = channel.id;
      const msg = interaction.options.getString('message');
      if (msg) cfg.goodbye.message = msg;
      db.save();
      await interaction.editReply(`Goodbye messages enabled in <#${cfg.goodbye.channel}>.`);
    } else if (sub === 'levels') {
      cfg.levels.enabled = interaction.options.getBoolean('enabled');
      db.save();
      await interaction.editReply(`Leveling system is now **${cfg.levels.enabled ? 'enabled' : 'disabled'}**.`);
    } else if (sub === 'tickets') {
      const category = await getOrCreateSetupCategory(guild);
      const panelChannel = interaction.options.getChannel('panel_channel') || await findOrCreateChannel(guild, 'tickets', category);
      const transcriptChannel = interaction.options.getChannel('transcript_channel') || await findOrCreateChannel(guild, 'ticket-transcripts', category);
      const staffRole = interaction.options.getRole('staff_role') || await findOrCreateRole(guild, 'Support', 0x57f287);
      cfg.tickets.panelChannel = panelChannel.id;
      cfg.tickets.transcriptChannel = transcriptChannel.id;
      if (!cfg.tickets.staffRoles.includes(staffRole.id)) cfg.tickets.staffRoles.push(staffRole.id);
      cfg.tickets.enabled = true;
      db.save();
      await postTicketPanel(panelChannel, cfg.tickets);
      await interaction.editReply(`Ticket system set up in ${panelChannel} (transcripts to ${transcriptChannel}, staff role <@&${staffRole.id}>).`);
    }
    return;
  }
}

// ------------------------------------------------------------
// Auto-create helpers for /setup — so admins never have to name
// or pre-create a channel/role themselves.
// ------------------------------------------------------------
async function getOrCreateSetupCategory(guild) {
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'Bot Management');
  if (!category) {
    category = await guild.channels.create({ name: 'Bot Management', type: ChannelType.GuildCategory });
  }
  return category;
}

async function findOrCreateChannel(guild, name, category) {
  let channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category ? category.id : undefined,
      permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.SendMessages] }],
    });
  }
  return channel;
}

async function findOrCreateRole(guild, name, color) {
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) {
    role = await guild.roles.create({ name, color, reason: '/setup auto-created role' });
  }
  return role;
}

async function postTicketPanel(channel, ticketsCfg) {
  const embed = baseEmbed(COLOR).setTitle('🎫 Support Tickets').setDescription('Select a category below to open a ticket. Our staff team will assist you shortly.');
  const menu = new StringSelectMenuBuilder().setCustomId('ticket_category_select').setPlaceholder('Choose a ticket category')
    .addOptions(ticketsCfg.categories.map(c => ({ label: c.label, value: c.id, emoji: c.emoji })));
  const row = new ActionRowBuilder().addComponents(menu);
  await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
}


// ------------------------------------------------------------
// Button / Select Menu / Modal Handlers (Tickets + Reaction Roles)
// ------------------------------------------------------------
async function handleSelectMenu(interaction) {
  if (interaction.customId === 'ticket_category_select') {
    const guildData = db.guild(interaction.guild.id);
    const categoryId = interaction.values[0];
    const category = guildData.config.tickets.categories.find(c => c.id === categoryId);

    // cooldown check
    const cooldownUntil = guildData.ticketCooldowns[interaction.user.id] || 0;
    if (Date.now() < cooldownUntil) {
      const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
      await interaction.reply({ content: `Please wait ${secs}s before opening another ticket.`, ephemeral: true });
      return;
    }

    // build a short question modal before creating the ticket
    const modal = new ModalBuilder().setCustomId(`ticket_modal_${categoryId}`).setTitle(`New Ticket — ${category.label}`);
    const reasonInput = new TextInputBuilder().setCustomId('ticket_reason').setLabel('Briefly describe your issue').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
  }
}

async function handleModal(interaction) {
  if (interaction.customId.startsWith('ticket_modal_')) {
    const categoryId = interaction.customId.replace('ticket_modal_', '');
    const guild = interaction.guild;
    const guildData = db.guild(guild.id);
    const cfg = guildData.config.tickets;
    const category = cfg.categories.find(c => c.id === categoryId);
    const reasonText = interaction.fields.getTextInputValue('ticket_reason');

    await interaction.deferReply({ ephemeral: true });

    cfg.counter += 1;
    const ticketNumber = cfg.counter;
    const channelName = `ticket-${ticketNumber.toString().padStart(4, '0')}`;

    const permissionOverwrites = [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];
    for (const roleId of cfg.staffRoles) {
      permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites,
    });

    guildData.tickets[channel.id] = {
      number: ticketNumber,
      userId: interaction.user.id,
      category: categoryId,
      claimedBy: null,
      status: 'open',
      createdAt: Date.now(),
      transcript: [],
    };
    guildData.ticketCooldowns[interaction.user.id] = Date.now() + cfg.cooldownSeconds * 1000;
    db.save();

    const embed = baseEmbed(COLOR).setTitle(`Ticket #${ticketNumber} — ${category.label}`)
      .setDescription(`**Opened by:** ${fmtUser(interaction.user)}\n**Reason:** ${reasonText}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
      new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    );
    const staffMention = cfg.staffRoles.map(id => `<@&${id}>`).join(' ');
    await channel.send({ content: `${interaction.user} ${staffMention}`, embeds: [embed], components: [row] });

    await interaction.editReply(`Your ticket has been created: ${channel}`);
  }
}

async function handleButton(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  const guildData = db.guild(guild.id);

  // ---- Reaction role buttons ----
  if (interaction.customId.startsWith('rr_')) {
    const roleId = interaction.customId.split('_')[1];
    const member = interaction.member;
    const hasRole = member.roles.cache.has(roleId);
    try {
      if (hasRole) {
        await member.roles.remove(roleId);
        await interaction.reply({ content: `Removed <@&${roleId}>.`, ephemeral: true });
      } else {
        await member.roles.add(roleId);
        await interaction.reply({ content: `Added <@&${roleId}>.`, ephemeral: true });
      }
    } catch {
      await interaction.reply({ content: 'I could not update your roles (check my role position/permissions).', ephemeral: true });
    }
    return;
  }

  // ---- Ticket buttons ----
  if (interaction.customId === 'ticket_claim') {
    const ticket = guildData.tickets[interaction.channel.id];
    if (!ticket) return;
    if (!isStaff(interaction.member, guildData)) {
      await interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
      return;
    }
    ticket.claimedBy = interaction.user.id;
    db.save();
    await interaction.reply(`🙋 Ticket claimed by ${interaction.user}.`);
    return;
  }

  if (interaction.customId === 'ticket_close') {
    const ticket = guildData.tickets[interaction.channel.id];
    if (!ticket) return;
    if (!isStaff(interaction.member, guildData) && interaction.user.id !== ticket.userId) {
      await interaction.reply({ content: 'You cannot close this ticket.', ephemeral: true });
      return;
    }
    await closeTicket(interaction.channel, guildData, interaction.user, 'Closed via button');
    return;
  }
}

async function closeTicket(channel, guildData, closer, reason) {
  const ticket = guildData.tickets[channel.id];
  if (!ticket) return;

  // build a simple text transcript
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => new Collection());
  const transcriptLines = [...messages.values()].reverse().map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content}`);
  const transcriptText = transcriptLines.join('\n') || '(no messages)';

  ticket.status = 'closed';
  db.save();

  const transcriptChannelId = guildData.config.tickets.transcriptChannel;
  if (transcriptChannelId) {
    const transcriptChannel = await channel.guild.channels.fetch(transcriptChannelId).catch(() => null);
    if (transcriptChannel) {
      const embed = baseEmbed(COLOR).setTitle(`Ticket #${ticket.number} Closed`)
        .setDescription(`**Opened by:** <@${ticket.userId}>\n**Closed by:** ${fmtUser(closer)}\n**Reason:** ${reason}`);
      const buffer = Buffer.from(transcriptText, 'utf8');
      transcriptChannel.send({ embeds: [embed], files: [{ attachment: buffer, name: `ticket-${ticket.number}-transcript.txt` }] }).catch(() => {});
    }
  }

  await channel.send(`🔒 This ticket will be deleted in 5 seconds. Reason: ${reason}`);
  setTimeout(() => channel.delete().catch(() => {}), 5000);
}


// ------------------------------------------------------------
// Ready Event / Login / Error Handling
// ------------------------------------------------------------
client.once('ready', async () => {
  console.log(`[READY] Logged in as ${client.user.tag} (${client.user.id})`);
  client.user.setPresence({ activities: [{ name: '/help | server security & management' }], status: 'online' });
  await registerCommands();
});

process.on('unhandledRejection', (err) => console.error('[UNHANDLED REJECTION]', err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT EXCEPTION]', err));

client.login(TOKEN);

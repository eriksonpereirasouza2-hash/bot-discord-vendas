import 'dotenv/config';
import {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType
} from 'discord.js';
import { createClient } from '@supabase/supabase-js';

const required = ['DISCORD_TOKEN','DISCORD_CLIENT_ID','DISCORD_GUILD_ID',
  'SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','MODERATOR_ROLE_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Variável ausente no .env: ${key}`);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const PAGE_SIZE = 3;
const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const isModerator = member => Boolean(member?.roles?.cache?.has(process.env.MODERATOR_ROLE_ID));

async function getProducts() {
  const { data, error } = await supabase.from('products')
    .select('*').eq('active', true).order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

function catalogPayload(products, page) {
  const pages = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const shown = products.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const embeds = shown.map(p => {
    const e = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(p.name)
      .setDescription(p.description || 'Sem descrição.')
      .addFields({ name: 'Preço', value: money(p.price_cents), inline: true })
      .setFooter({ text: `Página ${current + 1}/${pages} • Produto ${p.id}` });
    if (p.image_url) e.setImage(p.image_url);
    return e;
  });
  const rows = shown.map(p => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`buy:${p.id}`).setLabel(`Comprar: ${p.name.slice(0, 55)}`)
      .setStyle(ButtonStyle.Success)
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`catalog:${current - 1}`).setLabel('◀ Anterior')
      .setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(`catalog:${current + 1}`).setLabel('Próxima ▶')
      .setStyle(ButtonStyle.Secondary).setDisabled(current >= pages - 1)
  ));
  return { content: products.length ? `🛍️ **${process.env.STORE_NAME || 'Catálogo'}**` : 'O catálogo está vazio.',
    embeds, components: rows };
}

async function createOrder(interaction, product) {
  const guild = interaction.guild;
  const safeName = `pedido-${interaction.user.username}`.toLowerCase()
    .replace(/[^a-z0-9-]/g, '').slice(0, 18);
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] }
  ];
  const modRole = guild.roles.cache.get(process.env.MODERATOR_ROLE_ID);
  if (modRole) overwrites.push({ id: modRole.id, allow: [
    PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory
  ]});
  const channel = await guild.channels.create({
    name: safeName, type: ChannelType.GuildText,
    parent: process.env.TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
    topic: `Atendimento de compra para ${interaction.user.id}`
  });
  const { data: order, error } = await supabase.from('orders').insert({
    discord_user_id: interaction.user.id,
    discord_username: interaction.user.username,
    product_id: product.id,
    product_name: product.name,
    amount_cents: product.price_cents,
    ticket_channel_id: channel.id
  }).select().single();
  if (error) {
    await channel.delete().catch(() => {});
    throw error;
  }

  const testMode = process.env.PAYMENTS_TEST_MODE !== 'false';
  const payEmbed = new EmbedBuilder().setColor(0xFEE75C)
    .setTitle('🧾 Pedido criado')
    .setDescription('Um moderador vai acompanhar seu pedido neste canal.')
    .addFields(
      { name: 'Produto', value: product.name, inline: true },
      { name: 'Valor', value: money(product.price_cents), inline: true },
      { name: 'Pedido', value: order.id.slice(0, 8), inline: true },
      { name: 'Identificador Discord', value: interaction.user.id }
    );
  if (testMode) {
    payEmbed.addFields({ name: 'Pagamento', value:
      '🧪 **Modo de teste ativo.** Nenhuma cobrança PIX real foi criada. Aguarde as instruções do responsável pela loja.' });
  } else {
    payEmbed.addFields({ name: 'Pagamento', value:
      `Chave PIX informada pelo responsável: **${process.env.PIX_KEY_DISPLAY || 'não configurada'}**\n` +
      `Recebedor: ${process.env.PIX_RECEIVER_NAME || 'não configurado'} • Cidade: ${process.env.PIX_CITY || 'não configurada'}\n` +
      'Confira os dados com o responsável antes de pagar. O bot não confirma pagamentos automaticamente.' });
  }
  await channel.send({ content: `<@${interaction.user.id}>`, embeds: [payEmbed] });
  await interaction.followUp({ content: `Seu canal privado foi criado: ${channel}`, ephemeral: true });
}

async function listOrders(interaction) {
  if (!isModerator(interaction.member)) {
    return interaction.reply({ content: '⛔ Apenas quem tem o cargo **Moderador** pode usar este comando.', ephemeral: true });
  }
  const { data, error } = await supabase.from('orders').select('*')
    .eq('status', 'pending').order('created_at', { ascending: true }).limit(8);
  if (error) throw error;
  if (!data?.length) return interaction.reply({ content: 'Não há pedidos pendentes.', ephemeral: true });
  await interaction.reply({ content: `📦 **Pedidos pendentes (${data.length})**`, ephemeral: true });
  for (const order of data) {
    const embed = new EmbedBuilder().setColor(0xFEE75C).setTitle(`Pedido ${order.id.slice(0,8)}`)
      .addFields(
        { name: 'Cliente', value: `${order.discord_username} (<@${order.discord_user_id}>)` },
        { name: 'Produto', value: order.product_name, inline: true },
        { name: 'Valor', value: money(order.amount_cents), inline: true },
        { name: 'Criado em', value: new Date(order.created_at).toLocaleString('pt-BR') }
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`order:approve:${order.id}`).setLabel('Confirmar compra').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`order:deny:${order.id}`).setLabel('Negar compra').setStyle(ButtonStyle.Danger)
    );
    await interaction.followUp({ embeds: [embed], components: [row], ephemeral: true });
  }
}

async function dashboard(interaction) {
  if (!isModerator(interaction.member)) {
    return interaction.reply({ content: '⛔ Apenas moderadores podem abrir o dashboard.', ephemeral: true });
  }
  const period = interaction.options.getString('periodo') || 'week';
  const since = period === 'day' ? new Date(Date.now() - 864e5)
    : period === 'week' ? new Date(Date.now() - 7 * 864e5)
    : period === 'month' ? new Date(Date.now() - 30 * 864e5) : null;
  let query = supabase.from('orders').select('amount_cents,status,created_at');
  if (since) query = query.gte('created_at', since.toISOString());
  const { data, error } = await query;
  if (error) throw error;
  const orders = data || [];
  const approved = orders.filter(o => o.status === 'approved');
  const pending = orders.filter(o => o.status === 'pending');
  const denied = orders.filter(o => o.status === 'denied');
  const total = approved.reduce((sum, o) => sum + o.amount_cents, 0);
  const label = { day: 'Hoje', week: 'Últimos 7 dias', month: 'Últimos 30 dias', all: 'Todo o período' }[period];
  const embed = new EmbedBuilder().setColor(0x57F287).setTitle('📊 Dashboard de vendas')
    .setDescription(`Resumo: **${label}**`)
    .addFields(
      { name: 'Pedidos', value: String(orders.length), inline: true },
      { name: 'Aprovados', value: String(approved.length), inline: true },
      { name: 'Pendentes', value: String(pending.length), inline: true },
      { name: 'Negados', value: String(denied.length), inline: true },
      { name: 'Valor aprovado', value: money(total), inline: true },
      { name: 'Ticket médio', value: money(approved.length ? Math.round(total / approved.length) : 0), inline: true }
    ).setTimestamp();
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

client.once(Events.ClientReady, c => console.log(`Online como ${c.user.tag}`));
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'comprar') {
        await interaction.deferReply({ ephemeral: true });
        const products = await getProducts();
        return interaction.editReply(catalogPayload(products, 0));
      }
      if (interaction.commandName === 'pedidos') return await listOrders(interaction);
      if (interaction.commandName === 'dashboard') return await dashboard(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('catalog:')) {
        const page = Number(interaction.customId.split(':')[1]);
        const products = await getProducts();
        return interaction.update(catalogPayload(products, page));
      }
      if (interaction.customId.startsWith('buy:')) {
        await interaction.deferReply({ ephemeral: true });
        const productId = interaction.customId.slice(4);
        const { data: product, error } = await supabase.from('products')
          .select('*').eq('id', productId).eq('active', true).single();
        if (error || !product) return interaction.editReply('Esse produto não está mais disponível.');
        await createOrder(interaction, product);
        return;
      }
      if (interaction.customId.startsWith('order:')) {
        if (!isModerator(interaction.member)) {
          return interaction.reply({ content: '⛔ Ação exclusiva para moderadores.', ephemeral: true });
        }
        const [, action, id] = interaction.customId.split(':');
        const status = action === 'approve' ? 'approved' : 'denied';
        const { data: order, error } = await supabase.from('orders').update({
          status, moderator_id: interaction.user.id, updated_at: new Date().toISOString()
        }).eq('id', id).eq('status', 'pending').select().maybeSingle();
        if (error) throw error;
        if (!order) return interaction.reply({ content: 'Este pedido já foi processado.', ephemeral: true });
        await interaction.update({ content: `Pedido ${id.slice(0,8)}: **${status === 'approved' ? 'COMPRA CONFIRMADA' : 'COMPRA NEGADA'}** por ${interaction.user}.`, embeds: [], components: [] });
        const ticket = interaction.guild.channels.cache.get(order.ticket_channel_id);
        if (ticket) await ticket.send(status === 'approved'
          ? `✅ Compra confirmada por ${interaction.user}.`
          : `❌ Compra negada por ${interaction.user}.`);
      }
    }
  } catch (error) {
    console.error(error);
    const message = 'Ocorreu um erro. Confira as configurações e os logs do bot.';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});
client.login(process.env.DISCORD_TOKEN);

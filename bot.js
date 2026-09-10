const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const ARTIFACTS = path.join(ROOT, 'artifacts');
const LOGS_DIR = path.join(ROOT, 'logs');
const HISTORY_PATH = path.join(LOGS_DIR, 'historico.log');
const CONFIG_PATH = path.join(ROOT, 'config.json');

fs.mkdirSync(ARTIFACTS, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

let sensitiveValues = [];
let historicoRegistrado = false;

function horarioBrasil() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date());
}

function log(message) {
  console.log(`[${horarioBrasil()}] ${message}`);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function limparSegredos(texto) {
  let output = String(texto ?? '');
  for (const value of sensitiveValues) {
    if (!value) continue;
    output = output.split(value).join('***');
  }
  return output;
}

function textoEmUmaLinha(texto) {
  return limparSegredos(texto)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function registrarHistorico(status, detalhe, config = null) {
  const personagem = textoEmUmaLinha(config?.personagem || 'não identificado');
  const run = process.env.GITHUB_RUN_NUMBER ? `#${process.env.GITHUB_RUN_NUMBER}` : 'local';
  const linha = `${horarioBrasil()} | ${personagem} | ${status} | ${textoEmUmaLinha(detalhe)} | ${run}\n`;

  fs.appendFileSync(HISTORY_PATH, linha, 'utf8');
  historicoRegistrado = true;
  log(`Histórico registrado: ${status}.`);
}

function carregarConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('config.json não encontrado.');

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  config.email = process.env.DAEVA_USER || config.email || config.usuario;
  config.senhaLogin = process.env.DAEVA_PASSWORD || config.senhaLogin || config.senha;
  config.senhaFicha = process.env.DAEVA_SHEET_PASSWORD || config.senhaFicha;
  config.personagem = String(config.personagem || '').trim();
  config.fichaUrl = String(config.fichaUrl || '').trim();

  const baseUrl = config.homeUrl || config.loginUrl || config.fichaUrl;
  if (!baseUrl) throw new Error('Configure ao menos homeUrl, loginUrl ou fichaUrl.');

  const origin = new URL(baseUrl).origin;
  if (!config.homeUrl) config.homeUrl = origin;
  if (!config.loginUrl) config.loginUrl = `${origin}/login`;

  sensitiveValues = [config.email, config.senhaLogin, config.senhaFicha]
    .map(v => String(v || '').trim())
    .filter(Boolean);

  return config;
}

function validarConfig(config) {
  const faltando = [];
  if (!config.email || String(config.email).includes('COLOQUE_')) faltando.push('email');
  if (!config.senhaLogin || String(config.senhaLogin).includes('COLOQUE_')) faltando.push('senhaLogin');
  if (!config.senhaFicha || String(config.senhaFicha).includes('COLOQUE_')) faltando.push('senhaFicha');
  if (!config.personagem || String(config.personagem).includes('COLOQUE_')) faltando.push('personagem');
  if (faltando.length) throw new Error(`Preencha no config.json: ${faltando.join(', ')}.`);
}

async function salvarDiagnostico(page, prefix) {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, `${prefix}.png`), fullPage: true });
  } catch (_) {}

  try {
    const html = limparSegredos(await page.content());
    fs.writeFileSync(path.join(ARTIFACTS, `${prefix}.html`), html, 'utf8');
  } catch (_) {}
}

async function primeiroVisivel(page, selectors) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) return loc;
  }
  return null;
}

async function fazerLogin(page, config) {
  log('Abrindo tela de login.');
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const email = await primeiroVisivel(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="exemplo.com" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="e-mail" i]'
  ]);
  const senha = await primeiroVisivel(page, ['input[type="password"]']);

  if (!email || !senha) {
    await salvarDiagnostico(page, 'erro-tela-login');
    throw new Error('Campos de login não encontrados.');
  }

  await email.fill(String(config.email));
  await senha.fill(String(config.senhaLogin));

  let entrar = page.getByRole('button', { name: /^entrar$/i }).last();
  if (!(await entrar.isVisible().catch(() => false))) {
    entrar = page.locator('button[type="submit"]').last();
  }

  log('Enviando login.');
  await entrar.click({ timeout: 7000 });
  await page.waitForTimeout(1800);

  if (page.url().toLowerCase().includes('/login')) {
    await salvarDiagnostico(page, 'erro-login-rejeitado');
    throw new Error('O login não avançou. Confira e-mail e senha de login.');
  }

  log('Login concluído.');
}

function urlEhFicha(page) {
  try {
    return new URL(page.url()).pathname.startsWith('/ficha/');
  } catch (_) {
    return false;
  }
}

function mesmaFichaConfigurada(page, config) {
  if (!config.fichaUrl) return urlEhFicha(page);

  try {
    const atual = new URL(page.url());
    const alvo = new URL(config.fichaUrl);
    return atual.origin === alvo.origin && atual.pathname === alvo.pathname;
  } catch (_) {
    return false;
  }
}

async function abrirFichaConfigurada(page, config) {
  log(`Abrindo a página principal e procurando a ficha "${config.personagem}".`);
  await page.goto(config.homeUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const nomeExato = page.getByText(
    new RegExp(`^${escapeRegExp(config.personagem)}$`, 'i')
  ).first();

  if (await nomeExato.isVisible().catch(() => false)) {
    await nomeExato.scrollIntoViewIfNeeded().catch(() => {});
    await nomeExato.click({ timeout: 7000 }).catch(() => null);
    await page.waitForTimeout(1500);
  }

  if (!urlEhFicha(page)) {
    if (!config.fichaUrl) {
      await salvarDiagnostico(page, 'erro-ficha-nao-abriu');
      throw new Error(`A ficha "${config.personagem}" não abriu e fichaUrl não foi configurada como fallback.`);
    }

    log('A abertura pelo cartão não foi confirmada; usando fichaUrl do config como fallback.');
    await page.goto(config.fichaUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
  }

  if (page.url().toLowerCase().includes('/login')) {
    throw new Error('A sessão não permaneceu autenticada ao abrir a ficha.');
  }

  if (!mesmaFichaConfigurada(page, config)) {
    await salvarDiagnostico(page, 'erro-ficha-diferente');
    throw new Error('A página aberta não corresponde à ficha configurada. Nenhum clique será feito.');
  }

  log(`Ficha configurada para "${config.personagem}" aberta.`);
}

async function desbloquearFicha(page, config) {
  const tituloProtegida = page.getByText(/ficha protegida/i).first();
  const estaProtegida = await tituloProtegida.isVisible().catch(() => false);

  if (!estaProtegida) {
    log('Ficha já está revelada nesta sessão.');
    return;
  }

  log('Ficha protegida detectada. Inserindo senha da ficha.');

  const senha = await primeiroVisivel(page, [
    'input[placeholder*="senha da ficha" i]',
    'input[type="password"]'
  ]);
  const revelar = page.getByRole('button', { name: /revelar ficha/i }).first();

  if (!senha || !(await revelar.isVisible().catch(() => false))) {
    await salvarDiagnostico(page, 'erro-desbloqueio-ficha');
    throw new Error('Não encontrei o campo/botão de desbloqueio da ficha.');
  }

  await senha.fill(String(config.senhaFicha));
  await revelar.click({ timeout: 7000 });
  await page.waitForTimeout(1200);

  if (await tituloProtegida.isVisible().catch(() => false)) {
    await salvarDiagnostico(page, 'erro-senha-ficha');
    throw new Error('A ficha continuou bloqueada. Confira a senha da ficha.');
  }

  log('Ficha revelada com sucesso.');
}

async function confirmarPersonagem(page, config) {
  const nome = page.getByText(
    new RegExp(`^${escapeRegExp(config.personagem)}$`, 'i')
  ).first();

  if (!(await nome.isVisible().catch(() => false))) {
    await salvarDiagnostico(page, 'erro-personagem-nao-confirmado');
    throw new Error(`Não consegui confirmar que a ficha aberta pertence a "${config.personagem}". Nenhum clique será feito.`);
  }

  log(`Personagem confirmado pela ficha: ${config.personagem}.`);
}

async function encontrarBotaoMeditar(page) {
  const grupos = [
    page.getByRole('button', { name: /\+?\s*1\s*qi/i }),
    page.getByRole('button', { name: /meditar/i }),
    page.locator('button:has-text("+1 QI")'),
    page.locator('button:has-text("Meditar")')
  ];

  for (const grupo of grupos) {
    const count = await grupo.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = grupo.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function estaDisponivel(button) {
  if (!(await button.isVisible().catch(() => false))) return false;
  if (!(await button.isEnabled().catch(() => false))) return false;

  return button.evaluate(el => {
    const style = getComputedStyle(el);
    return !(
      el.getAttribute('aria-disabled') === 'true' ||
      style.pointerEvents === 'none' ||
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      String(el.className || '').toLowerCase().includes('cursor-not-allowed')
    );
  }).catch(() => false);
}

async function tentarMeditar(page, config) {
  if (!mesmaFichaConfigurada(page, config)) {
    throw new Error('Proteção acionada: fora da ficha configurada. Nenhum clique será feito.');
  }

  await confirmarPersonagem(page, config);

  const botao = await encontrarBotaoMeditar(page);
  if (!botao) {
    log('Botão +1 QI/Meditar não encontrado nesta verificação. Nada será clicado.');
    registrarHistorico('INDISPONIVEL', 'Botão +1 QI/Meditar não estava disponível nesta verificação.', config);
    await salvarDiagnostico(page, 'meditar-nao-encontrado');
    return;
  }

  if (!(await estaDisponivel(botao))) {
    log('Meditar está indisponível. Nada será clicado.');
    registrarHistorico('INDISPONIVEL', 'Botão de meditação encontrado, mas estava desabilitado.', config);
    await salvarDiagnostico(page, 'meditar-indisponivel');
    return;
  }

  if (!mesmaFichaConfigurada(page, config)) {
    throw new Error('Proteção acionada antes do clique: a ficha mudou.');
  }

  log('Meditação disponível. Clicando uma única vez em +1 QI.');
  await botao.click({ timeout: 7000 });
  await page.waitForTimeout(1800);

  const depois = await encontrarBotaoMeditar(page);
  if (!depois || !(await estaDisponivel(depois))) {
    log('Meditação confirmada pela interface: botão ficou indisponível.');
    registrarHistorico('MEDITOU', '+1 QI clicado e confirmado pela interface.', config);
  } else {
    log('Clique enviado, mas o botão ainda parece habilitado. O bot não fará segundo clique nesta execução.');
    registrarHistorico('CLIQUE_ENVIADO', 'Clique em +1 QI foi enviado, mas a interface não confirmou a mudança de estado.', config);
  }

  await salvarDiagnostico(page, 'meditacao-realizada');
}

async function executar() {
  let config = null;
  let browser;
  let page;

  try {
    config = carregarConfig();
    validarConfig(config);

    browser = await chromium.launch({
      headless: config.headless !== false,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1440, height: 1100 }
    });

    page = await context.newPage();
    page.setDefaultTimeout(Number(config.timeoutMs || 30000));

    await fazerLogin(page, config);
    await abrirFichaConfigurada(page, config);
    await desbloquearFicha(page, config);
    await tentarMeditar(page, config);

    if (!historicoRegistrado) {
      registrarHistorico('OK', 'Execução concluída sem clique e sem erro.', config);
    }

    log('Execução finalizada.');
  } catch (error) {
    log(`ERRO: ${error.message}`);

    try {
      registrarHistorico('ERRO', error.message, config);
    } catch (historyError) {
      log(`ERRO AO GRAVAR HISTÓRICO: ${historyError.message}`);
    }

    if (page) await salvarDiagnostico(page, 'erro-execucao');
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

executar();

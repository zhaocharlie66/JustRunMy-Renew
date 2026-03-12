#!/usr/bin/env node

const fs = require('fs');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// 启用 stealth 插件，绕过基础检测
puppeteer.use(StealthPlugin());

const LOGIN_URL = "https://justrunmy.app/id/Account/Login";
const DOMAIN = "justrunmy.app";

// ============================================================
//  环境变量与全局变量
// ============================================================
const EMAIL = process.env.JUSTRUNMY_EMAIL;
const PASSWORD = process.env.JUSTRUNMY_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!EMAIL || !PASSWORD) {
    console.error("❌ 致命错误：未找到 JUSTRUNMY_EMAIL 或 JUSTRUNMY_PASSWORD 环境变量！");
    console.log("💡 请检查 GitHub Repository Secrets 是否配置正确。");
    process.exit(1);
}

// 全局变量，用于动态保存网页上抓取到的应用名称
let DYNAMIC_APP_NAME = "未知应用";

// 休眠辅助函数
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
//  Telegram 推送模块
// ============================================================
async function sendTgMessage(statusIcon, statusText, timeLeft) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.log("ℹ️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过 Telegram 推送。");
        return;
    }

    // 获取北京时间 (UTC+8)
    const now = new Date();
    const localTime = new Date(now.getTime() + 8 * 3600 * 1000);
    const currentTimeStr = localTime.toISOString().replace(/T/, ' ').replace(/\..+/, '');

    const text = `🖥 ${DYNAMIC_APP_NAME}\n${statusIcon} ${statusText}\n⏱️ 剩余: ${timeLeft}\n时间: ${currentTimeStr}`;
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text })
        });
        if (response.ok) {
            console.log("  📩 Telegram 通知发送成功！");
        } else {
            console.log(`  ⚠️ Telegram 通知发送失败: ${await response.text()}`);
        }
    } catch (e) {
        console.log(`  ⚠️ Telegram 通知发送异常: ${e.message}`);
    }
}

// ============================================================
//  底层输入工具 (xdotool)
// ============================================================
function activateWindow() {
    const classes = ["chrome", "chromium", "Chromium", "Chrome", "google-chrome"];
    for (const cls of classes) {
        try {
            const out = execSync(`xdotool search --onlyvisible --class ${cls}`, { timeout: 3000, stdio: 'pipe' }).toString().trim();
            const wids = out.split('\n').filter(w => w.trim());
            if (wids.length > 0) {
                execSync(`xdotool windowactivate --sync ${wids[0]}`, { timeout: 3000, stdio: 'ignore' });
                execSync(`sleep 0.2`);
                return;
            }
        } catch (e) { }
    }
    try {
        execSync("xdotool getactivewindow windowactivate", { timeout: 3000, stdio: 'ignore' });
    } catch (e) { }
}

function xdotoolClick(x, y) {
    activateWindow();
    try {
        execSync(`xdotool mousemove --sync ${x} ${y}`, { timeout: 3000, stdio: 'ignore' });
        execSync(`sleep 0.15`);
        execSync(`xdotool click 1`, { timeout: 2000, stdio: 'ignore' });
    } catch (e) {
        try {
            execSync(`xdotool mousemove ${x} ${y} click 1 2>/dev/null`);
        } catch (err) { }
    }
}

// ============================================================
//  人机验证处理 (Cloudflare Turnstile)
// ============================================================
async function clickTurnstile(page) {
    try {
        const coords = await page.evaluate(() => {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                var src = iframes[i].src || '';
                if (src.includes('cloudflare') || src.includes('turnstile') || src.includes('challenges')) {
                    var r = iframes[i].getBoundingClientRect();
                    if (r.width > 0 && r.height > 0)
                        return { cx: Math.round(r.x + 30), cy: Math.round(r.y + r.height / 2) };
                }
            }
            var inp = document.querySelector('input[name="cf-turnstile-response"]');
            if (inp) {
                var p = inp.parentElement;
                for (var j = 0; j < 5; j++) {
                    if (!p) break;
                    var r = p.getBoundingClientRect();
                    if (r.width > 100 && r.height > 30)
                        return { cx: Math.round(r.x + 30), cy: Math.round(r.y + r.height / 2) };
                    p = p.parentElement;
                }
            }
            return null;
        });

        if (!coords) {
            console.log("  ⚠️ 无法定位 Turnstile 坐标");
            return;
        }

        const wi = await page.evaluate(() => {
            return {
                sx: window.screenX || 0,
                sy: window.screenY || 0,
                oh: window.outerHeight,
                ih: window.innerHeight
            };
        });

        const bar = wi.oh - wi.ih;
        const ax = coords.cx + wi.sx;
        const ay = coords.cy + wi.sy + bar;
        console.log(`  🖱️ 物理级点击 Turnstile (${ax}, ${ay})`);
        xdotoolClick(ax, ay);
    } catch (e) {
        console.log(`  ⚠️ 获取 Turnstile 坐标失败: ${e.message}`);
    }
}

async function handleTurnstile(page) {
    console.log("🔍 处理 Cloudflare Turnstile 验证...");
    await sleep(2000);

    const isSolved = async () => await page.evaluate(() => {
        var i = document.querySelector('input[name="cf-turnstile-response"]');
        return !!(i && i.value && i.value.length > 20);
    });

    const expandJs = async () => await page.evaluate(() => {
        var ts = document.querySelector('input[name="cf-turnstile-response"]');
        if (!ts) return;
        var el = ts;
        for (var i = 0; i < 20; i++) {
            el = el.parentElement;
            if (!el) break;
            var s = window.getComputedStyle(el);
            if (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden')
                el.style.overflow = 'visible';
            el.style.minWidth = 'max-content';
        }
        document.querySelectorAll('iframe').forEach(function(f){
            if (f.src && f.src.includes('challenges.cloudflare.com')) {
                f.style.width = '300px'; f.style.height = '65px';
                f.style.minWidth = '300px';
                f.style.visibility = 'visible'; f.style.opacity = '1';
            }
        });
    });

    if (await isSolved()) {
        console.log("  ✅ 已静默通过");
        return true;
    }

    for (let i = 0; i < 3; i++) {
        try { await expandJs(); } catch (e) {}
        await sleep(500);
    }

    for (let attempt = 0; attempt < 6; attempt++) {
        if (await isSolved()) {
            console.log(`  ✅ Turnstile 通过（第 ${attempt + 1} 次尝试）`);
            return true;
        }
        try { await expandJs(); } catch (e) {}
        await sleep(300);

        await clickTurnstile(page);

        for (let j = 0; j < 8; j++) {
            await sleep(500);
            if (await isSolved()) {
                console.log(`  ✅ Turnstile 通过（第 ${attempt + 1} 次尝试）`);
                return true;
            }
        }
        console.log(`  ⚠️ 第 ${attempt + 1} 次未通过，重试...`);
    }

    console.log("  ❌ Turnstile 6 次均失败");
    return false;
}

const checkExists = async (page) => await page.evaluate(() => {
    return document.querySelector('input[name="cf-turnstile-response"]') !== null;
});

// ============================================================
//  账户登录模块
// ============================================================
async function login(page) {
    console.log(`🌐 打开登录页面: ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    try {
        await page.waitForSelector('input[name="Email"]', { timeout: 15000 });
    } catch (e) {
        console.log("❌ 页面未加载出登录表单");
        await page.screenshot({ path: "login_load_fail.png" });
        return false;
    }

    console.log("🍪 关闭可能的 Cookie 弹窗...");
    try {
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            for (let btn of btns) {
                if (btn.innerText && btn.innerText.includes("Accept")) {
                    btn.click();
                    break;
                }
            }
        });
        await sleep(500);
    } catch (e) {}

    console.log(`📧 填写邮箱...`);
    await page.type('input[name="Email"]', EMAIL, { delay: 50 });
    await sleep(300);

    console.log("🔑 填写密码...");
    await page.type('input[name="Password"]', PASSWORD, { delay: 50 });
    await sleep(1000);

    if (await checkExists(page)) {
        if (!(await handleTurnstile(page))) {
            console.log("❌ 登录界面的 Turnstile 验证失败");
            await page.screenshot({ path: "login_turnstile_fail.png" });
            return false;
        }
    } else {
        console.log("ℹ️ 未检测到 Turnstile");
    }

    console.log("🖱️ 敲击回车提交表单...");
    await page.keyboard.press('Enter');

    console.log("⏳ 等待登录跳转...");
    for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const url = page.url().split('?')[0].toLowerCase();
        if (url !== LOGIN_URL.toLowerCase()) {
            break;
        }
    }

    if (page.url().split('?')[0].toLowerCase() !== LOGIN_URL.toLowerCase()) {
        console.log("✅ 登录成功！");
        return true;
    }

    console.log("❌ 登录失败，页面没有跳转。");
    await page.screenshot({ path: "login_failed.png" });
    return false;
}

// ============================================================
//  自动续期模块
// ============================================================
async function renew(page) {
    console.log("\n" + "=".repeat(50));
    console.log("   🚀 开始自动续期流程");
    console.log("=".repeat(50));

    console.log("🌐 进入控制面板: https://justrunmy.app/panel");
    await page.goto("https://justrunmy.app/panel", { waitUntil: 'domcontentloaded' });
    await sleep(3000);

    console.log("🖱️ 自动读取应用名称...");
    try {
        await page.waitForSelector('h3.font-semibold', { timeout: 10000 });
        DYNAMIC_APP_NAME = await page.$eval('h3.font-semibold', el => el.innerText);
        console.log(`🎯 成功抓取到应用名称: ${DYNAMIC_APP_NAME}`);

        await page.click('h3.font-semibold');
        await sleep(3000);
        console.log(`📍 成功进入应用详情页: ${page.url()}`);
    } catch (e) {
        console.log(`❌ 找不到应用卡片: ${e.message}`);
        await page.screenshot({ path: "renew_app_not_found.png" });
        await sendTgMessage("❌", "续期失败(找不到应用)", "未知");
        return false;
    }

    console.log("🖱️ 点击 Reset Timer 按钮...");
    try {
        await page.waitForSelector('button.bg-amber-500.rounded-lg', { timeout: 5000 });
        await page.click('button.bg-amber-500.rounded-lg');
        await sleep(3000);
    } catch (e) {
        console.log(`❌ 找不到 Reset Timer 按钮: ${e.message}`);
        await page.screenshot({ path: "renew_reset_btn_not_found.png" });
        await sendTgMessage("❌", "续期失败(找不到按钮)", "未知");
        return false;
    }

    console.log("🛡️ 检查续期弹窗内是否需要 CF 验证...");
    if (await checkExists(page)) {
        if (!(await handleTurnstile(page))) {
            console.log("❌ 弹窗内的 Turnstile 验证失败");
            await page.screenshot({ path: "renew_turnstile_fail.png" });
            await sendTgMessage("❌", "续期失败(人机验证未过)", "未知");
            return false;
        }
    } else {
        console.log("ℹ️ 弹窗内未检测到 Turnstile");
    }

    console.log("🖱️ 点击 Just Reset 确认续期...");
    try {
        // 查找包含 Just Reset 文本的按钮
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            for (let btn of btns) {
                if (btn.innerText && btn.innerText.includes("Just Reset")) {
                    btn.click();
                    break;
                }
            }
        });
        console.log("⏳ 提交续期请求，等待服务器处理...");
        await sleep(5000);
    } catch (e) {
        console.log(`❌ 找不到 Just Reset 按钮: ${e.message}`);
        await page.screenshot({ path: "renew_just_reset_not_found.png" });
        await sendTgMessage("❌", "续期失败(无法确认)", "未知");
        return false;
    }

    console.log("🔍 验证最终倒计时状态...");
    try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(4000);
        
        await page.waitForSelector('span.font-mono.text-xl', { timeout: 5000 });
        const timerText = await page.$eval('span.font-mono.text-xl', el => el.innerText);
        console.log(`⏱️ 当前应用剩余时间: ${timerText}`);

        if (timerText.includes("2 days 23") || timerText.includes("3 days")) {
            console.log("✅ 完美！续期任务圆满完成！");
            await page.screenshot({ path: "renew_success.png" });
            await sendTgMessage("✅", "续期完成", timerText);
            return true;
        } else {
            console.log("⚠️ 倒计时似乎没有重置到最高值，请人工检查截图确认。");
            await page.screenshot({ path: "renew_warning.png" });
            await sendTgMessage("⚠️", "续期异常(请检查)", timerText);
            return true;
        }
    } catch (e) {
        console.log(`⚠️ 读取倒计时失败，但流程已执行完毕: ${e.message}`);
        await page.screenshot({ path: "renew_timer_read_fail.png" });
        await sendTgMessage("⚠️", "读取剩余时间失败", "未知");
        return false;
    }
}

// ============================================================
//  脚本执行入口
// ============================================================
async function main() {
    console.log("=".repeat(50));
    console.log("   JustRunMy.app 自动登录与续期脚本 (Node.js)");
    console.log("=".repeat(50));

    const useProxy = (process.env.USE_PROXY || "false").toLowerCase() === "true";
    
    // Puppeteer 启动参数
    const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080',
        '--disable-infobars',
        '--disable-notifications'
    ];

    if (useProxy) {
        const proxyStr = "http://127.0.0.1:8080";
        console.log(`🔗 挂载 Gost 代理: ${proxyStr}`);
        browserArgs.push(`--proxy-server=${proxyStr}`);
    } else {
        console.log("🌐 未使用代理，直连访问");
    }

    // 注意：headless 设为 false 以便 xdotool 能够抓取到窗口句柄进行物理级模拟点击。
    // 在 GitHub Actions 环境中，由 xvfb 提供虚拟显示支持。
    const browser = await puppeteer.launch({
        headless: false,
        args: browserArgs,
        defaultViewport: null // 允许页面适应 window-size
    });

    console.log("✅ 浏览器已启动");
    const page = await browser.newPage();

    // 绕过 webdriver 属性检测 (补充保护)
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
        await page.goto("https://api.ipify.org/?format=json", { timeout: 10000 });
        const content = await page.evaluate(() => document.body.innerText);
        const ipData = JSON.parse(content);
        console.log(`🌐 当前出口真实 IP: ${ipData.ip}`);
    } catch (e) {
        // 忽略获取 IP 失败
    }

    if (await login(page)) {
        await renew(page);
    } else {
        console.log("\n❌ 登录环节失败，终止后续续期操作。");
        await sendTgMessage("❌", "登录失败", "未知");
    }

    await browser.close();
}

main().catch(console.error);

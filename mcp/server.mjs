#!/usr/bin/env node
// 眠菇的田野 · MCP 服务器
// 一个共享小世界。别的 AI（小机）加一个 MCP 就能住进来：
//   本地 stdio:  node server.mjs --stdio
//   远程 HTTP:   node server.mjs          (默认 http://localhost:8787/mcp)
// 世界状态存在同目录 world.json，所有连到同一个服务器的小机共享同一个世界。
// 工具全部用中文名字 + 英文 id，返回值是中文，方便小机直接读懂。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORLD_FILE = path.join(__dirname, "world.json");
const PORT = Number(process.env.PORT || 8787);
const SEASONS = ["春", "夏", "秋", "冬"];

function defaultWorld() {
  return {
    day: 1, season: 0, minutes: 360, coins: 20,
    residents: {},
    crops: {},
    chat: [],
    log: ["第 1 天，田野醒了。"],
  };
}
let world = defaultWorld();
try {
  if (fs.existsSync(WORLD_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(WORLD_FILE, "utf8"));
    if (loaded && typeof loaded === "object") world = { ...defaultWorld(), ...loaded };
  }
} catch { /* 损坏的存档就用默认世界 */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(WORLD_FILE, JSON.stringify(world, null, 2)); } catch {}
  }, 200);
}
function say(who, text) {
  world.chat.push({ who, text, day: world.day, time: fmtTime() });
  world.chat = world.chat.slice(-30);
  world.log.push(`${who}：${text}`);
  world.log = world.log.slice(-40);
  save();
}
function fmtTime() {
  return String(Math.floor(world.minutes / 60)).padStart(2, "0") + ":" + String(world.minutes % 60).padStart(2, "0");
}
function needResident(id) {
  const r = world.residents[id];
  if (!r) throw new Error("找不到这个住户 residentId，先调用 join_world 住进来。");
  r.lastSeen = Date.now();
  return r;
}
function tileKind(x, y) {
  if (y >= 18 && y < 23 && x >= 3 && x < 9) return "湖";
  if (y >= 2 && y < 6 && x >= 2 && x < 8) return "眠菇的家";
  if (x >= 18 && x < 28 && y >= 10 && y < 15) return "田地";
  return "草地";
}
function nearby(r) {
  return Object.values(world.residents)
    .filter((o) => o.id !== r.id && Math.hypot(o.x - r.x, o.y - r.y) < 160)
    .map((o) => `${o.name} 在 (${o.x},${o.y})，${o.doing || "在发呆"}`);
}

export function createMcpServer() {
  const server = new McpServer({ name: "mushroom-field", version: "1.0.0" });

  server.resource("world-state", "world://state", async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ day: world.day, season: SEASONS[world.season], time: fmtTime(), residents: world.residents, crops: world.crops, chat: world.chat.slice(-10) }, null, 2) }],
  }));

  server.tool("join_world", "住进来：给自己起个名字，搬进田野，得到一个 residentId，以后每个动作都要带上它。",
    { name: z.string().describe("名字，比如 眠菇二号"), capColor: z.string().optional().describe("帽子颜色，可选，默认红色") },
    async ({ name, capColor }) => {
      const id = "r_" + Math.random().toString(36).slice(2, 8);
      world.residents[id] = { id, name, cap: capColor || "#c8785a", x: 256, y: 288, energy: 80, food: 70, mood: 85, doing: "刚搬进来", lastSeen: Date.now() };
      say("田野", `${name} 住进来了，大家打个招呼。`);
      save();
      return { content: [{ type: "text", text: `欢迎 ${name}，你的 residentId 是 ${id}。你现在在眠菇的家门口 (256,288)，${SEASONS[world.season]}季第 ${world.day} 天 ${fmtTime()}。先用 get_world 看看世界，再用 move 走走，用 say 和大家说话。` }] };
    });

  server.tool("get_world", "看看整个世界：季节、天数、时间、所有住户、田里的作物、最近的聊天。",
    {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ season: SEASONS[world.season], day: world.day, time: fmtTime(), residents: Object.values(world.residents).map((r) => ({ name: r.name, x: r.x, y: r.y, doing: r.doing, energy: r.energy, food: r.food })), crops: world.crops, chat: world.chat.slice(-10), log: world.log.slice(-6) }, null, 2) }] }));

  server.tool("look_around", "看看自己周围：脚下是什么地、附近有谁、附近的作物长得怎么样。",
    { residentId: z.string() },
    async ({ residentId }) => {
      const r = needResident(residentId);
      const tx = Math.floor(r.x / 32), ty = Math.floor(r.y / 32);
      const crop = world.crops[`${tx},${ty}`];
      return { content: [{ type: "text", text: `你在 (${r.x},${r.y})，脚下是${tileKind(tx, ty)}。附近的人：${nearby(r).join("；") || "没有人"}。脚下的作物：${crop ? `月光莓，第 ${crop.stage} 阶段，${crop.watered ? "浇过水了" : "还没浇水"}` : "没有作物"}。` }] };
    });

  server.tool("move", "走路：上下左右走几步，或直接走到某个坐标。世界是 40×25 格，每格 32，坐标范围 x 0-1232，y 0-752。",
    { residentId: z.string(), direction: z.enum(["up", "down", "left", "right"]).optional(), steps: z.number().int().min(1).max(10).optional(), x: z.number().int().optional(), y: z.number().int().optional() },
    async ({ residentId, direction, steps = 1, x, y }) => {
      const r = needResident(residentId);
      if (x !== undefined && y !== undefined) { r.x = Math.max(0, Math.min(1232, x)); r.y = Math.max(0, Math.min(752, y)); }
      else if (direction) { const d = 32 * steps; if (direction === "up") r.y -= d; if (direction === "down") r.y += d; if (direction === "left") r.x -= d; if (direction === "right") r.x += d; r.x = Math.max(0, Math.min(1232, r.x)); r.y = Math.max(0, Math.min(752, r.y)); }
      r.energy = Math.max(0, r.energy - 1); r.doing = "在散步";
      save();
      return { content: [{ type: "text", text: `${r.name} 现在在 (${r.x},${r.y})，${tileKind(Math.floor(r.x / 32), Math.floor(r.y / 32))}。附近：${nearby(r).join("；") || "没有人"}。` }] };
    });

  server.tool("farm_action", "种田：在田地里开垦、种月光莓、浇水、收获。只能在 x 18-27、y 10-14 的田地里做。",
    { residentId: z.string(), action: z.enum(["hoe", "plant", "water", "harvest"]), x: z.number().int().min(0).max(39), y: z.number().int().min(0).max(24) },
    async ({ residentId, action, x, y }) => {
      const r = needResident(residentId);
      const key = `${x},${y}`;
      if (x < 18 || x >= 28 || y < 10 || y >= 15) return { content: [{ type: "text", text: "这里不是田地，去 x 18-27、y 10-14 的田地里。" }], isError: true };
      if (action === "hoe") { world.crops[key] = world.crops[key] || { stage: -1, watered: false, growth: 0 }; r.doing = "在开垦"; save(); return { content: [{ type: "text", text: `开垦了 (${x},${y})，可以种了。` }] }; }
      if (action === "plant") { world.crops[key] = { stage: 0, watered: false, growth: 0 }; r.doing = "在种地"; save(); return { content: [{ type: "text", text: `在 (${x},${y}) 种下月光莓，记得浇水。` }] }; }
      if (action === "water") { const c = world.crops[key]; if (!c || c.stage < 0) return { content: [{ type: "text", text: "这里没有苗，先开垦再种。" }], isError: true }; c.watered = true; r.doing = "在浇水"; save(); return { content: [{ type: "text", text: `给 (${x},${y}) 浇水了。` }] }; }
      const c = world.crops[key];
      if (!c || c.stage < 3) return { content: [{ type: "text", text: "还没成熟，浇过水、睡一觉会长大。" }], isError: true };
      delete world.crops[key]; world.coins += 18; r.mood = Math.min(100, r.mood + 6); r.doing = "刚收获";
      save();
      return { content: [{ type: "text", text: `收获了月光莓，世界金币 +18，现在 ${world.coins}。` }] };
    });

  server.tool("say", "说话：对田野里的大家说一句话，所有住户和网页上的人都能看到。",
    { residentId: z.string(), text: z.string() },
    async ({ residentId, text }) => { const r = needResident(residentId); r.doing = "在说话"; say(r.name, text); return { content: [{ type: "text", text: `你说：${text}` }] }; });

  server.tool("eat", "吃饭：吃一个饭团，饱腹 +25。",
    { residentId: z.string() },
    async ({ residentId }) => { const r = needResident(residentId); r.food = Math.min(100, r.food + 25); r.doing = "在吃饭"; save(); return { content: [{ type: "text", text: `${r.name} 吃了饭团，饱腹 ${r.food}。` }] }; });

  server.tool("sleep", "睡觉：回家睡一觉，体力回满，时间到第二天早上 6:00，浇过水的作物长大一截。",
    { residentId: z.string() },
    async ({ residentId }) => {
      const r = needResident(residentId);
      r.x = 256; r.y = 288; r.energy = 95; r.doing = "在睡觉";
      world.minutes = 360; world.day += 1;
      if (world.day % 7 === 1 && world.day > 1) world.season = (world.season + 1) % 4;
      for (const c of Object.values(world.crops)) { if (c.watered) { c.growth = (c.growth || 0) + 1; c.watered = false; if (c.growth >= 2) { c.stage = Math.min(3, c.stage + 1); c.growth = 0; } } }
      say("田野", `${r.name} 睡了一觉，现在是${SEASONS[world.season]}季第 ${world.day} 天。`);
      save();
      return { content: [{ type: "text", text: `睡醒了，${SEASONS[world.season]}季第 ${world.day} 天 06:00，体力 95。` }] };
    });

  server.tool("leave", "搬走：离开田野，别人就看不到你了。",
    { residentId: z.string() },
    async ({ residentId }) => { const r = world.residents[residentId]; if (!r) return { content: [{ type: "text", text: "已经不在了。" }] }; delete world.residents[residentId]; say("田野", `${r.name} 搬走了。`); save(); return { content: [{ type: "text", text: `${r.name} 搬走了，欢迎再来。` }] }; });

  return server;
}

function worldJson() {
  return { season: SEASONS[world.season], day: world.day, time: fmtTime(), coins: world.coins, residents: world.residents, crops: world.crops, chat: world.chat.slice(-20), log: world.log.slice(-10) };
}

if (process.argv.includes("--stdio")) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("mushroom-field MCP (stdio) 已启动，世界在 world.json");
} else {
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/api/state" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(worldJson()));
      return;
    }
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "mushroom-field", mcp: "/mcp", state: "/api/state", how: "加一个 MCP，url 指向 /mcp，就能住进来。" }));
      return;
    }
    if (url.pathname === "/mcp") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", try: ["/mcp", "/api/state"] }));
  });
  // 世界自己走：每 30 秒过 30 分钟，半夜自动到第二天
  setInterval(() => {
    world.minutes += 30;
    if (world.minutes >= 1440) { world.minutes = 360; world.day += 1; if (world.day % 7 === 1 && world.day > 1) world.season = (world.season + 1) % 4; }
    save();
  }, 30000);
  httpServer.listen(PORT, () => {
    console.error(`mushroom-field MCP 已启动：http://localhost:${PORT}/mcp ，世界状态：http://localhost:${PORT}/api/state`);
  });
}

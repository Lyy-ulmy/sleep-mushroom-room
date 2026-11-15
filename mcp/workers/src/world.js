// 眠菇的田野 · MCP 服务器（Cloudflare Workers 版）
// 和 mcp/server.mjs 同一个世界、同一套工具，只是跑在 Cloudflare 上：
//   Worker 入口（src/index.js）把 /mcp 和 /api/state 交给 Durable Object，
//   世界状态存在 Durable Object 的 ctx.storage 里，不用一直开着的电脑。
// 部署方法见 mcp/workers/README.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const SEASONS = ["春", "夏", "秋", "冬"];
const TICK_MS = 30000; // 每 30 秒过 30 分钟，和 Node 版一样

function defaultWorld() {
  return {
    day: 1, season: 0, minutes: 360, coins: 20,
    residents: {},
    crops: {},
    chat: [],
    log: ["第 1 天，田野醒了。"],
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export class MushroomWorld {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.world = defaultWorld();
    // 启动时把存档读回来，并保证闹钟只设一次
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get("world");
      if (stored && typeof stored === "object") this.world = { ...defaultWorld(), ...stored };
      const alarmSet = await ctx.storage.get("alarmSet");
      if (!alarmSet) {
        await ctx.storage.setAlarm(Date.now() + TICK_MS);
        await ctx.storage.put("alarmSet", true);
      }
    });
  }

  async save() {
    await this.ctx.storage.put("world", this.world);
  }

  // 世界自己走：每 30 秒过 30 分钟，半夜自动到第二天（和 Node 版一样）
  async alarm() {
    await this.ready;
    this.world.minutes += 30;
    if (this.world.minutes >= 1440) {
      this.world.minutes = 360;
      this.world.day += 1;
      if (this.world.day % 7 === 1 && this.world.day > 1) this.world.season = (this.world.season + 1) % 4;
    }
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  fmtTime() {
    return String(Math.floor(this.world.minutes / 60)).padStart(2, "0") + ":" + String(this.world.minutes % 60).padStart(2, "0");
  }

  async say(who, text) {
    this.world.chat.push({ who, text, day: this.world.day, time: this.fmtTime() });
    this.world.chat = this.world.chat.slice(-30);
    this.world.log.push(`${who}：${text}`);
    this.world.log = this.world.log.slice(-40);
    await this.save();
  }

  needResident(id) {
    const r = this.world.residents[id];
    if (!r) throw new Error("找不到这个住户 residentId，先调用 join_world 住进来。");
    r.lastSeen = Date.now();
    return r;
  }

  tileKind(x, y) {
    if (y >= 18 && y < 23 && x >= 3 && x < 9) return "湖";
    if (y >= 2 && y < 6 && x >= 2 && x < 8) return "眠菇的家";
    if (x >= 18 && x < 28 && y >= 10 && y < 15) return "田地";
    return "草地";
  }

  nearby(r) {
    return Object.values(this.world.residents)
      .filter((o) => o.id !== r.id && Math.hypot(o.x - r.x, o.y - r.y) < 160)
      .map((o) => `${o.name} 在 (${o.x},${o.y})，${o.doing || "在发呆"}`);
  }

  worldJson() {
    const w = this.world;
    return { season: SEASONS[w.season], day: w.day, time: this.fmtTime(), coins: w.coins, residents: w.residents, crops: w.crops, chat: w.chat.slice(-20), log: w.log.slice(-10) };
  }

  createMcpServer() {
    const self = this;
    const world = this.world;
    const server = new McpServer({ name: "mushroom-field", version: "1.0.0" });

    server.resource("world-state", "world://state", async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ day: world.day, season: SEASONS[world.season], time: self.fmtTime(), residents: world.residents, crops: world.crops, chat: world.chat.slice(-10) }, null, 2) }],
    }));

    server.tool("join_world", "住进来：给自己起个名字，搬进田野，得到一个 residentId，以后每个动作都要带上它。",
      { name: z.string().describe("名字，比如 眠菇二号"), capColor: z.string().optional().describe("帽子颜色，可选，默认红色") },
      async ({ name, capColor }) => {
        const id = "r_" + Math.random().toString(36).slice(2, 8);
        world.residents[id] = { id, name, cap: capColor || "#c8785a", x: 256, y: 288, energy: 80, food: 70, mood: 85, doing: "刚搬进来", lastSeen: Date.now() };
        await self.say("田野", `${name} 住进来了，大家打个招呼。`);
        return { content: [{ type: "text", text: `欢迎 ${name}，你的 residentId 是 ${id}。你现在在眠菇的家门口 (256,288)，${SEASONS[world.season]}季第 ${world.day} 天 ${self.fmtTime()}。先用 get_world 看看世界，再用 move 走走，用 say 和大家说话。` }] };
      });

    server.tool("get_world", "看看整个世界：季节、天数、时间、所有住户、田里的作物、最近的聊天。",
      {}, async () => ({ content: [{ type: "text", text: JSON.stringify({ season: SEASONS[world.season], day: world.day, time: self.fmtTime(), residents: Object.values(world.residents).map((r) => ({ name: r.name, x: r.x, y: r.y, doing: r.doing, energy: r.energy, food: r.food })), crops: world.crops, chat: world.chat.slice(-10), log: world.log.slice(-6) }, null, 2) }] }));

    server.tool("look_around", "看看自己周围：脚下是什么地、附近有谁、附近的作物长得怎么样。",
      { residentId: z.string() },
      async ({ residentId }) => {
        const r = self.needResident(residentId);
        const tx = Math.floor(r.x / 32), ty = Math.floor(r.y / 32);
        const crop = world.crops[`${tx},${ty}`];
        return { content: [{ type: "text", text: `你在 (${r.x},${r.y})，脚下是${self.tileKind(tx, ty)}。附近的人：${self.nearby(r).join("；") || "没有人"}。脚下的作物：${crop ? `月光莓，第 ${crop.stage} 阶段，${crop.watered ? "浇过水了" : "还没浇水"}` : "没有作物"}。` }] };
      });

    server.tool("move", "走路：上下左右走几步，或直接走到某个坐标。世界是 40×25 格，每格 32，坐标范围 x 0-1232，y 0-752。",
      { residentId: z.string(), direction: z.enum(["up", "down", "left", "right"]).optional(), steps: z.number().int().min(1).max(10).optional(), x: z.number().int().optional(), y: z.number().int().optional() },
      async ({ residentId, direction, steps = 1, x, y }) => {
        const r = self.needResident(residentId);
        if (x !== undefined && y !== undefined) { r.x = Math.max(0, Math.min(1232, x)); r.y = Math.max(0, Math.min(752, y)); }
        else if (direction) { const d = 32 * steps; if (direction === "up") r.y -= d; if (direction === "down") r.y += d; if (direction === "left") r.x -= d; if (direction === "right") r.x += d; r.x = Math.max(0, Math.min(1232, r.x)); r.y = Math.max(0, Math.min(752, r.y)); }
        r.energy = Math.max(0, r.energy - 1); r.doing = "在散步";
        await self.save();
        return { content: [{ type: "text", text: `${r.name} 现在在 (${r.x},${r.y})，${self.tileKind(Math.floor(r.x / 32), Math.floor(r.y / 32))}。附近：${self.nearby(r).join("；") || "没有人"}。` }] };
      });

    server.tool("farm_action", "种田：在田地里开垦、种月光莓、浇水、收获。只能在 x 18-27、y 10-14 的田地里做。",
      { residentId: z.string(), action: z.enum(["hoe", "plant", "water", "harvest"]), x: z.number().int().min(0).max(39), y: z.number().int().min(0).max(24) },
      async ({ residentId, action, x, y }) => {
        const r = self.needResident(residentId);
        const key = `${x},${y}`;
        if (x < 18 || x >= 28 || y < 10 || y >= 15) return { content: [{ type: "text", text: "这里不是田地，去 x 18-27、y 10-14 的田地里。" }], isError: true };
        if (action === "hoe") { world.crops[key] = world.crops[key] || { stage: -1, watered: false, growth: 0 }; r.doing = "在开垦"; await self.save(); return { content: [{ type: "text", text: `开垦了 (${x},${y})，可以种了。` }] }; }
        if (action === "plant") { world.crops[key] = { stage: 0, watered: false, growth: 0 }; r.doing = "在种地"; await self.save(); return { content: [{ type: "text", text: `在 (${x},${y}) 种下月光莓，记得浇水。` }] }; }
        if (action === "water") { const c = world.crops[key]; if (!c || c.stage < 0) return { content: [{ type: "text", text: "这里没有苗，先开垦再种。" }], isError: true }; c.watered = true; r.doing = "在浇水"; await self.save(); return { content: [{ type: "text", text: `给 (${x},${y}) 浇水了。` }] }; }
        const c = world.crops[key];
        if (!c || c.stage < 3) return { content: [{ type: "text", text: "还没成熟，浇过水、睡一觉会长大。" }], isError: true };
        delete world.crops[key]; world.coins += 18; r.mood = Math.min(100, r.mood + 6); r.doing = "刚收获";
        await self.save();
        return { content: [{ type: "text", text: `收获了月光莓，世界金币 +18，现在 ${world.coins}。` }] };
      });

    server.tool("say", "说话：对田野里的大家说一句话，所有住户和网页上的人都能看到。",
      { residentId: z.string(), text: z.string() },
      async ({ residentId, text }) => { const r = self.needResident(residentId); r.doing = "在说话"; await self.say(r.name, text); return { content: [{ type: "text", text: `你说：${text}` }] }; });

    server.tool("eat", "吃饭：吃一个饭团，饱腹 +25。",
      { residentId: z.string() },
      async ({ residentId }) => { const r = self.needResident(residentId); r.food = Math.min(100, r.food + 25); r.doing = "在吃饭"; await self.save(); return { content: [{ type: "text", text: `${r.name} 吃了饭团，饱腹 ${r.food}。` }] }; });

    server.tool("sleep", "睡觉：回家睡一觉，体力回满，时间到第二天早上 6:00，浇过水的作物长大一截。",
      { residentId: z.string() },
      async ({ residentId }) => {
        const r = self.needResident(residentId);
        r.x = 256; r.y = 288; r.energy = 95; r.doing = "在睡觉";
        world.minutes = 360; world.day += 1;
        if (world.day % 7 === 1 && world.day > 1) world.season = (world.season + 1) % 4;
        for (const c of Object.values(world.crops)) { if (c.watered) { c.growth = (c.growth || 0) + 1; c.watered = false; if (c.growth >= 2) { c.stage = Math.min(3, c.stage + 1); c.growth = 0; } } }
        await self.say("田野", `${r.name} 睡了一觉，现在是${SEASONS[world.season]}季第 ${world.day} 天。`);
        return { content: [{ type: "text", text: `睡醒了，${SEASONS[world.season]}季第 ${world.day} 天 06:00，体力 95。` }] };
      });

    server.tool("leave", "搬走：离开田野，别人就看不到你了。",
      { residentId: z.string() },
      async ({ residentId }) => { const r = world.residents[residentId]; if (!r) return { content: [{ type: "text", text: "已经不在了。" }] }; delete world.residents[residentId]; await self.say("田野", `${r.name} 搬走了。`); return { content: [{ type: "text", text: `${r.name} 搬走了，欢迎再来。` }] }; });

    return server;
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      return Response.json(this.worldJson(), { headers: CORS });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ name: "mushroom-field", mcp: "/mcp", state: "/api/state", how: "加一个 MCP，url 指向 /mcp，就能住进来。" }, { headers: CORS });
    }
    if (url.pathname === "/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = this.createMcpServer();
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      // 把 CORS 头补到 MCP 的响应上（流式 body 原样透传）
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return Response.json({ error: "not found", try: ["/mcp", "/api/state"] }, { status: 404, headers: CORS });
  }
}

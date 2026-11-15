// 眠菇的田野 · MCP 服务器（Cloudflare Workers 版）入口
// 所有请求都交给同一个 Durable Object（名字叫 main），全世界的小机
// 共享同一个世界。世界状态存在 Durable Object 的 ctx.storage 里。
import { MushroomWorld } from "./world.js";

export { MushroomWorld };

export default {
  async fetch(request, env) {
    const id = env.MUSHROOM_WORLD.idFromName("main");
    const stub = env.MUSHROOM_WORLD.get(id);
    return stub.fetch(request);
  },
};

import type { AiRequest, AiResult, AiService } from "@kaelen/editor-plugin-ai";

/**
 * playground 的模拟 AI 服务。
 *
 * 与 `playgroundUploader` 同一定位：它**不接任何模型**，只是把真实服务会有的
 * 那几件事演出来——有延迟、会流式吐字、能被取消、也会拒答。这一片要演示的是
 * 位置契约，不是模型能力，所以返回的文字刻意写得一眼能看出是模拟的。
 *
 * 生产宿主把 `AiService` 换成自己的实现即可，编辑器那一侧不需要知道。
 */

/** 首字出现前的等待。真实模型也有这段，位置就是在这段时间里过期的。 */
const FIRST_TOKEN_MS = 400;
const CHUNK_MS = 60;
const CHUNK_SIZE = 4;

export interface PlaygroundAi {
  service: AiService;
  /**
   * 手动兑现最早的那个待决请求。只在 `?e2e=1` 下装配：用例要精确控制"结果在
   * 组合态的哪一刻到达"，等模拟服务的定时器是等不准的。
   */
  settle(result: AiResult): boolean;
}

export function createPlaygroundAi(manual: boolean): PlaygroundAi {
  const parked: Array<(result: AiResult) => void> = [];
  return {
    settle(result) {
      const resolve = parked.shift();
      resolve?.(result);
      return resolve !== undefined;
    },
    service: {
      run: (request, { signal, onDelta }) => {
        if (manual) {
          return new Promise<AiResult>((resolve) => {
            parked.push(resolve);
            signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
          });
        }
        return simulate(request, signal, onDelta);
      },
    },
  };
}

/** 被取消的请求不会有人读这个结果，返回什么都行；给一个说得清的值。 */
const ABORTED: AiResult = { ok: false, reason: "unavailable", message: "请求已取消" };

async function simulate(
  request: AiRequest,
  signal: AbortSignal,
  onDelta?: (delta: string) => void,
): Promise<AiResult> {
  // 拒答这条路径要能演示：真实模型的拒答是一次成功的响应，不是异常。
  if (request.text.includes("机密") || request.instruction?.includes("拒绝")) {
    await wait(FIRST_TOKEN_MS, signal);
    return { ok: false, reason: "refused", message: "模拟服务拒绝处理这段内容" };
  }

  const text = compose(request);
  await wait(FIRST_TOKEN_MS, signal);
  for (let index = 0; index < text.length; index += CHUNK_SIZE) {
    if (signal.aborted) {
      return ABORTED;
    }
    onDelta?.(text.slice(index, index + CHUNK_SIZE));
    await wait(CHUNK_MS, signal);
  }
  return { ok: true, text };
}

function compose(request: AiRequest): string {
  const source = request.text.replace(/\s+/g, " ").trim();
  const suffix = request.instruction ? `（按要求：${request.instruction}）` : "";
  if (request.action === "rewrite") {
    return `${source}——模拟服务把这段重写了一遍${suffix}。`;
  }
  if (request.action === "continue") {
    return `模拟服务接着往下写：${tail(source)}，故事于是继续${suffix}。`;
  }
  return `模拟摘要：这段约 ${[...source].length} 字，说的是「${tail(source, 12)}」${suffix}。`;
}

/** 取末尾若干字，让续写和摘要看起来确实读过原文。 */
function tail(source: string, count = 8): string {
  const characters = [...source];
  return characters.slice(-count).join("");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// 更新检查（决策 25/26/27/28）。**不做静默自动更新** —— 查到新版弹一次原生
// dialog，用户点一下才下载。
//
// ⚠️ 决策 27：安装包由**主进程带 cookie 自己下**，不是 shell.openExternal 丢给
// 家人的默认浏览器。那个浏览器很可能从没登录过 cc-webui，点开只会拿到 401。
// 这条同时保住了「安装包路由不进公开面」。
//
// ⚠️ 这个文件不 import electron，dialog / 下载动作由主进程注入 —— 版本比较和
// 取版本这两段逻辑因此能直接测。

export type Release = { version: string; url: string; notes?: string };

/**
 * semver 比较：a 比 b 新则返回正数。
 *
 * ⚠️ **不能用字符串不等**（"1.10.0" !== "1.9.0" 是真，但方向是反的），也不能用
 * localeCompare —— "1.10.0" < "1.9.0" 在字典序下成立，会导致新版被当成旧版而
 * 永远不提示。预发布后缀（-beta.1）按「比同版本号的正式版旧」处理。
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((n) => Number(n) || 0);
    return { nums, pre: pre ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // 正式版 > 预发布
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * 拉 /api/meta 取 desktopClient 字段。
 *
 * ⚠️ /api/meta 是 `auth:"user"` 的路由，必须带 cookie —— 就是决策 14 里
 * 主进程从渲染进程那儿拿到的那一份。
 */
export async function fetchRelease(
  baseUrl: string,
  cookie: string | undefined,
): Promise<Release | undefined> {
  if (!cookie) return undefined;
  try {
    const res = await fetch(`${baseUrl}/api/meta`, {
      headers: { cookie },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { desktopClient?: Release };
    const r = body.desktopClient;
    // 没发布过客户端时这个字段整个缺席，是正常状态。
    if (!r?.version || !r?.url) return undefined;
    return r;
  } catch (err) {
    // 网络不通不该弹错误框打扰家人 —— 下次启动再查就是了。
    console.warn(`[updater] 查版本失败：${(err as Error).message}`);
    return undefined;
  }
}

/** 有没有比 current 更新的版本。 */
export function isNewer(release: Release, current: string): boolean {
  return compareSemver(release.version, current) > 0;
}

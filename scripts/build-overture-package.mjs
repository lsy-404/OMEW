import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.env.OMEW_OVERTURE_OUTPUT || join(root, "dist-overture"));
const stage = await mkdtemp(join(tmpdir(), "openmew-overture-"));
const packageRoot = join(stage, "package");
const workerRoot = join(packageRoot, "worker");
const wranglerOut = join(stage, "wrangler-out");
const assetsRoot = join(packageRoot, "assets");
const migrationsRoot = join(packageRoot, "migrations");

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else result.push(path);
  }
  return result;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function splitAssetLicense(assetLicense) {
  const englishHeading = "# OMEW Asset Use Terms (English reference translation)";
  const divider = `\n---\n\n${englishHeading}`;
  const dividerAt = assetLicense.indexOf(divider);
  if (dividerAt < 0) throw new Error("ASSET-LICENSE.md is missing its English reference translation divider");

  return {
    zh: assetLicense.slice(0, dividerAt).trim(),
    en: assetLicense.slice(dividerAt + divider.length - englishHeading.length).trim(),
  };
}

function nestMarkdown(markdown, levels = 2) {
  return markdown.replace(/^(#{1,6})(?= )/gm, (heading) => "#".repeat(Math.min(6, heading.length + levels)));
}

function buildTerms(assetLicense) {
  const assetTerms = splitAssetLicense(assetLicense);
  return {
    "zh-CN": `# OMEW Overture 部署与使用条款

> 中文文本为控制文本；英文文本仅为参考翻译。如有冲突，以中文文本为准。

在 Overture 中确认本条款并部署、运行、修改或分发 OMEW，即表示您同意遵守本条款、GNU Affero General Public License v3.0 以及适用于第三方材料的条款。若您不同意，请不要部署或使用 OMEW。

## 1. 软件代码与开源义务

OMEW 软件代码采用 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）**。完整许可证正文随应用清单提供，并以仓库中的 \`LICENSE\` 为准。

- 您可以在 AGPL-3.0-only 允许的范围内运行、复制、修改和分发软件代码，包括用于商业目的；美术资产不因此获得 AGPL 许可，仍受下文的独立限制。
- 如果您修改 OMEW，并通过计算机网络让用户与修改后的版本交互，必须依 AGPL 第 13 条向这些用户显著提供通过网络免费取得您所运行版本之相应源代码的方式。
- 复制、修改或分发时必须保留适用的版权声明、许可证声明、免责声明及 NOTICE，不得对 AGPL 授予的权利施加额外限制。其他具体义务以 AGPL-3.0-only 正文为准。

## 2. 官方美术与第三方贴纸

本节直接从仓库 \`ASSET-LICENSE.md\` 的中文控制文本派生；该文件是受限资产规则的单一事实来源。

${nestMarkdown(assetTerms.zh)}

## 3. Cloudflare 资源、费用与账户权限风险

- 部署器会在您选择的 Cloudflare 账户中创建或管理 Worker、D1 数据库、R2 存储桶与 Durable Object 命名空间，并上传静态资源、迁移数据库和设置密钥。仅当您提供自定义域名时，部署器才会读取区域并创建或管理相应域名路由。这些资源可能产生 Cloudflare 费用，费用由您承担。
- 部署需要账户级写入权限；仅在您提供自定义域名时，还需要相应区域的读取与路由写入权限。为支持实例管理而保存的 Worker 设置权限属于账户级权限，技术上可能修改同一账户中的其他 Worker；建议使用专用 Cloudflare 账户、遵循最小权限原则，并在不再需要时撤销或轮换凭据。
- 您应在确认前核对目标账户、资源名称、权限范围和计费设置；使用自定义域名时还应核对目标区域与域名。您自行负责实例的数据安全、访问控制、备份、维护和合规。

## 4. 按现状提供与无担保

在适用法律允许的最大范围内，OMEW 软件、部署包、部署配方和相关材料均按“现状”及“可用”状态提供，不附带任何明示、默示或法定担保，包括适销性、特定用途适用性、权利完整性、不侵权、持续可用或无错误的担保。您自行承担部署和运行风险，并负责遵守 AGPL、资产条款、第三方许可、Cloudflare 条款及所在法域的法律。
`,
    en: `# OMEW Overture Deployment and Use Terms (English reference translation)

> The Chinese text is controlling. This English text is provided only as a reference translation. If the texts conflict, the Chinese text prevails.

By accepting these terms in Overture and deploying, running, modifying, or distributing OMEW, you agree to these terms, the GNU Affero General Public License v3.0, and the terms applicable to third-party materials. Do not deploy or use OMEW if you do not agree.

## 1. Software code and open-source obligations

The OMEW software code is licensed under the **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**. The complete license text is supplied with the application manifest, and the repository's \`LICENSE\` file controls.

- You may run, copy, modify, and distribute the software code, including commercially, only as permitted by AGPL-3.0-only. Artwork receives no AGPL license and remains subject to the separate restrictions below.
- If you modify OMEW and users interact with that modified version remotely through a computer network, AGPL Section 13 requires you to offer those users a prominent way to receive the Corresponding Source of the version you run, free of charge through the network.
- When copying, modifying, or distributing the software, retain all applicable copyright notices, license notices, disclaimers, and NOTICE files, and do not impose further restrictions on rights granted by the AGPL. Refer to the AGPL-3.0-only text for the complete obligations.

## 2. Official artwork and third-party stickers

This section is derived directly from the English reference translation in the repository's \`ASSET-LICENSE.md\`. That file is the single source of truth for Restricted Asset rules.

${nestMarkdown(assetTerms.en)}

## 3. Cloudflare resources, charges, and account-permission risks

- The deployer creates or manages a Worker, D1 database, R2 bucket, and Durable Object namespaces in the Cloudflare account you select, and uploads static assets, applies database migrations, and configures secrets. Only when you provide a custom domain does it read a zone and create or manage the corresponding domain route. These resources may incur Cloudflare charges, which are your responsibility.
- Deployment requires account-level write permissions. Only when you provide a custom domain does it also require read and route-write permissions for the corresponding zone. The Worker-settings permission retained for instance administration is account-scoped and can technically modify other Workers in the same account. Use a dedicated Cloudflare account, follow least-privilege practices, and revoke or rotate credentials when they are no longer needed.
- Before accepting, verify the target account, resource names, permission scopes, and billing settings; when using a custom domain, also verify the target zone and domain. You are responsible for instance data security, access controls, backups, maintenance, and compliance.

## 4. As-is provision and no warranty

To the maximum extent permitted by applicable law, the OMEW software, deployment package, deployment recipe, and related materials are provided “as is” and “as available,” without express, implied, or statutory warranties, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, continuous availability, or error-free operation. You assume all deployment and operational risks and are responsible for compliance with the AGPL, the asset terms, third-party licenses, Cloudflare terms, and applicable law.
`,
  };
}

await rm(output, { recursive: true, force: true });
await mkdir(workerRoot, { recursive: true });
await mkdir(assetsRoot, { recursive: true });
await mkdir(migrationsRoot, { recursive: true });

run("npm", ["run", "build"]);
run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", wranglerOut, "--config", join(root, "server", "wrangler.jsonc")]);
await cp(join(wranglerOut, "api.js"), join(workerRoot, "index.js"));
await cp(join(root, "web", "dist"), assetsRoot, { recursive: true });

const assetManifest = {};
for (const path of await filesUnder(assetsRoot)) {
  const bytes = await readFile(path);
  const servedPath = `/${relative(assetsRoot, path).replaceAll("\\", "/")}`;
  assetManifest[servedPath] = { hash: createHash("md5").update(bytes).digest("hex"), size: bytes.length };
}
await writeFile(join(packageRoot, "assets-manifest.json"), `${JSON.stringify(assetManifest, null, 2)}\n`);

const migrations = (await filesUnder(join(root, "server", "migrations"))).sort();
await writeFile(join(migrationsRoot, "index.json"), `${JSON.stringify(migrations.map((path) => relative(join(root, "server", "migrations"), path)))}\n`);
for (const path of migrations) await cp(path, join(migrationsRoot, relative(join(root, "server", "migrations"), path)));
await cp(join(root, "overture", "recipe.js"), join(packageRoot, "recipe.js"));

const archive = join(output, "overture.tar.gz");
await mkdir(output, { recursive: true });
run("tar", ["czf", archive, "-C", packageRoot, "."]);
const archiveBytes = await readFile(archive);
const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
const version = process.env.OMEW_VERSION || (process.env.OMEW_TAG || "v1.0.0").replace(/^v/, "");
const tag = process.env.OMEW_TAG || `v${version}`;
const buildTime = process.env.OMEW_BUILD_TIME || new Date().toISOString();
const assetLicense = await readFile(join(root, "ASSET-LICENSE.md"), "utf8");
const manifest = {
  schema: 2,
  id: "openmew",
  name: "OMEW",
  summary: { en: "A community and chat server on Cloudflare Workers", "zh-CN": "运行在 Cloudflare Workers 上的社区与聊天服务器" },
  homepage: "https://github.com/lsy-404/OMEW",
  issues: { url: "https://github.com/lsy-404/OMEW/issues/new" },
  version,
  tag,
  buildTime,
  package: { artifact: "overture.tar.gz", sha256, bytes: archiveBytes.length },
  license: { id: "AGPL-3.0-only", text: await readFile(join(root, "LICENSE"), "utf8") },
  terms: { required: true, texts: buildTerms(assetLicense) },
  authModes: ["auto"],
  permissions: [
    { key: "scripts", requirement: "required", oauthScopes: ["workers-scripts.write", "workers-scripts.bind", "workers-scripts.read"], label: { en: "Workers Scripts", "zh-CN": "Workers Scripts" }, scenario: { en: "Inspect, upload, bind, and activate the OMEW Worker, assets, and Secrets", "zh-CN": "检查、上传、绑定并启用 OMEW Worker、静态资源与 Secrets" }, scope: "account", level: "write" },
    { key: "d1", requirement: "required", oauthScopes: ["d1.write", "d1.read"], label: { en: "D1", "zh-CN": "D1 数据库" }, scenario: { en: "Find or create the database and apply its schema", "zh-CN": "查找或创建数据库并写入数据库结构" }, scope: "account", level: "write" },
    { key: "r2", requirement: "required", oauthScopes: ["workers-r2.write", "workers-r2.read"], label: { en: "Workers R2 Storage", "zh-CN": "Workers R2 Storage" }, scenario: { en: "Find or create the media storage bucket", "zh-CN": "查找或创建媒体存储桶" }, scope: "account", level: "write" },
    { key: "domains", requirement: "optional", oauthScopes: ["workers-routes.read", "workers-routes.write", "zone.read"], label: { en: "Workers Routes", "zh-CN": "Workers Routes" }, scenario: { en: "Resolve and attach a custom domain if you provide one", "zh-CN": "仅在提供自定义域名时解析区域并完成绑定" }, scope: "account", level: "write" },
  ],
  resources: [
    { id: "db", kind: "d1", binding: "DB", defaultName: "${worker}-db", required: true, match: { names: ["openmew"], patterns: ["^openmew-db$"] }, label: { en: "OMEW database", "zh-CN": "OMEW 数据库" } },
    { id: "media", kind: "r2", binding: "MEDIA", defaultName: "${worker}-media", required: true, match: { names: ["omew-media"], patterns: ["^openmew-media$"] }, label: { en: "Media storage", "zh-CN": "媒体存储" } },
  ],
  worker: { defaultName: "openmew", module: "worker/index.js", assetsManifest: "assets-manifest.json", assetsDir: "assets", assetsRouting: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*", "/federation/*", "/stronghold", "/stronghold/*", "/inbox", "/inbox/*", "/media/*"] }, compatibilityDate: "2026-08-21", compatibilityFlags: ["nodejs_compat"], durableObjects: [{ binding: "ROOM_DO", className: "RoomDO", storage: "sqlite" }, { binding: "STRONGHOLD_DO", className: "StrongholdDO", storage: "sqlite" }], vars: [{ name: "INSTANCE_DOMAIN", value: "${input:domain}" }, { name: "R2_BUCKET_NAME", value: "${resource:media}" }, { name: "CF_WORKER_NAME", value: "${worker}" }] },
  inputs: [{ id: "domain", kind: "domain", required: false, label: { en: "Custom domain", "zh-CN": "自定义域名" }, help: { en: "Optional. Leave empty to use the Worker's *.workers.dev hostname.", "zh-CN": "可选。留空则使用 Worker 的 *.workers.dev 域名。" } }],
  capabilities: ["d1", "r2", "secrets", "worker", "assets", "domains"],
  hostSecrets: [
    { name: "CF_ACCOUNT_ID", source: "accountId", requirement: "required", reason: { en: "Keep the instance connected to its own Cloudflare account for administration.", "zh-CN": "让实例持续连接到所属 Cloudflare 账户，用于实例管理。" } },
    {
      name: "CF_API_TOKEN",
      source: "cfApiToken",
      requirement: "required",
      placeholder: { en: "cfat_…", "zh-CN": "cfat_…" },
      reason: {
        en: "Overture uses this token to deploy the Worker, database, and media storage, and to attach a custom domain only when you provide one. It then stores the token so OMEW can update its own Worker settings. These permissions are account- or zone-scoped, so a dedicated account is recommended.",
        "zh-CN": "Overture 使用此令牌部署 Worker、数据库与媒体存储，并仅在您提供自定义域名时完成绑定；随后将令牌保存供 OMEW 更新自身 Worker 设置。这些权限作用于账户或区域，建议使用专用账户。",
      },
      permissions: [
        { key: "workers_scripts", type: "edit", requirement: "required", scenario: { en: "Deploy the Worker, bindings, assets, and Secrets, and let OMEW update its own settings.", "zh-CN": "部署 Worker、bindings、静态资源与 Secrets，并允许 OMEW 更新自身设置。" } },
        { key: "d1", type: "edit", requirement: "required", scenario: { en: "Find or create the OMEW database and apply its schema.", "zh-CN": "查找或创建 OMEW 数据库并写入数据库结构。" } },
        { key: "workers_r2", type: "edit", requirement: "required", scenario: { en: "Find or create the OMEW media bucket.", "zh-CN": "查找或创建 OMEW 媒体存储桶。" } },
        { key: "workers_routes", type: "edit", requirement: "optional", scenario: { en: "Attach a custom domain if you provide one.", "zh-CN": "仅在提供自定义域名时完成绑定。" } },
        { key: "zone", type: "read", requirement: "optional", scenario: { en: "Resolve the zone only when you provide a custom domain.", "zh-CN": "仅在提供自定义域名时解析所属区域。" } },
      ],
    },
  ],
  steps: ["storage", "schema", "assets", "worker", "secrets"].map((id) => ({ id, label: { en: id, "zh-CN": id } })),
  done: { links: [{ label: { en: "Open OMEW", "zh-CN": "打开 OMEW" }, href: "${url}" }] },
};
await writeFile(join(output, "overture.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(output, "overture.tar.gz.sha256"), `${sha256}  overture.tar.gz\n`);
await rm(stage, { recursive: true, force: true });
console.log(JSON.stringify({ artifact: archive, sha256, bytes: archiveBytes.length }, null, 2));

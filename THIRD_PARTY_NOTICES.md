# Third-party notices

This file lists the third-party code that this repository contains, and the
third-party packages that it uses at run time.

`npm run notices` generates this file from `package-lock.json`, the
installed `node_modules` directory and the import list of the code under
`src/ui/`.
Do not edit it by hand.

No third-party source is copied into this repository. The page scripts are
built from the packages that the lockfile names, so every third-party file
the published package carries is either an installed runtime dependency or a
bundle of one.

The repository does not redistribute the packages in section 1. Install them
with npm. Most installed packages carry their license text. Some packages ship
no license file, and for those the license is the one that the table names, as
the package declares it in its `package.json`.

Section 1 holds every `package-lock.json` entry that is not a development
package, except the optional entries that carry an `os` or `cpu` field. Those
are one platform's build of a package, so this file leaves all of them out and
the list is the same on every machine.

Section 2 holds every package that code under `src/ui/` reaches. The build
bundles those packages into the page scripts. They are development
dependencies: the page code reaches them through the bundle, and the
published package ships the built bundle rather than the packages themselves.

## 1. Runtime dependencies

| Package | Version | License | Repository |
| --- | --- | --- | --- |
| @anthropic-ai/sdk | 0.129.0 | MIT | https://github.com/anthropics/anthropic-sdk-typescript |
| @aws-sdk/client-bedrock-runtime | 3.1127.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/clients/client-bedrock-runtime |
| @aws-sdk/core | 3.978.2 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/core |
| @aws-sdk/credential-provider-env | 3.972.73 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-env |
| @aws-sdk/credential-provider-http | 3.972.75 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-http |
| @aws-sdk/credential-provider-ini | 3.973.18 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-ini |
| @aws-sdk/credential-provider-login | 3.972.80 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-login |
| @aws-sdk/credential-provider-node | 3.972.85 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-node |
| @aws-sdk/credential-provider-process | 3.972.73 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-process |
| @aws-sdk/credential-provider-sso | 3.973.17 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-sso |
| @aws-sdk/credential-provider-web-identity | 3.972.79 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-web-identity |
| @aws-sdk/eventstream-handler-node | 3.972.36 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/eventstream-handler-node |
| @aws-sdk/middleware-eventstream | 3.972.31 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/middleware-eventstream |
| @aws-sdk/middleware-websocket | 3.972.55 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/middleware-websocket |
| @aws-sdk/nested-clients | 3.997.47 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/nested-clients |
| @aws-sdk/signature-v4-multi-region | 3.996.48 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/signature-v4-multi-region |
| @aws-sdk/token-providers | 3.1127.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/token-providers |
| @aws-sdk/token-providers | 3.1149.0 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/token-providers |
| @aws-sdk/types | 3.974.6 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/types |
| @aws-sdk/xml-builder | 3.972.41 | Apache-2.0 | https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/xml-builder |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | https://github.com/awslabs/aws-lambda-invoke-store |
| @babel/runtime | 7.29.10 | MIT | https://github.com/babel/babel/tree/HEAD/packages/babel-runtime |
| @earendil-works/chord | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/chord |
| @earendil-works/pi-agent-core | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/agent |
| @earendil-works/pi-ai | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/ai |
| @earendil-works/pi-codemode | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/codemode |
| @earendil-works/pi-coding-agent | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/coding-agent |
| @earendil-works/pi-durable | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/durable |
| @earendil-works/pi-mcp | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/mcp |
| @earendil-works/pi-schema | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/schema |
| @earendil-works/pi-telemetry | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/telemetry |
| @earendil-works/pi-tui | 1.5.0 | MIT | https://github.com/earendil-works/pi/tree/HEAD/packages/tui |
| @google/genai | 2.21.0 | Apache-2.0 | https://github.com/googleapis/js-genai |
| @isaacs/nonrecursive-glob-match | 1.0.3 | BlueOak-1.0.0 |  |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | https://github.com/dcodeIO/protobuf.js |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause | https://github.com/protobufjs/protobuf.js |
| @silvia-odwyer/photon | 0.3.3 | Apache-2.0 | https://github.com/silvia-odwyer/photon |
| @silvia-odwyer/photon-node | 0.3.4 | Apache-2.0 | https://github.com/silvia-odwyer/photon |
| @smithy/core | 3.35.2 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/core |
| @smithy/credential-provider-imds | 4.5.2 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/credential-provider-imds |
| @smithy/fetch-http-handler | 5.8.0 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/fetch-http-handler |
| @smithy/node-http-handler | 4.12.1 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/node-http-handler |
| @smithy/signature-v4 | 5.7.4 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/signature-v4 |
| @smithy/types | 4.19.0 | Apache-2.0 | https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/types |
| @stablelib/base64 | 1.0.1 | MIT | https://github.com/StableLib/stablelib |
| @types/node | 24.19.2 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node |
| @types/retry | 0.12.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| agent-base | 7.1.4 | MIT | https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/agent-base |
| agent-base | 9.0.0 | MIT | https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/agent-base |
| balanced-match | 4.0.4 | MIT | https://github.com/juliangruber/balanced-match |
| base64-js | 1.5.1 | MIT | https://github.com/beatgammit/base64-js |
| bignumber.js | 9.3.1 | MIT | https://github.com/MikeMcl/bignumber.js |
| bowser | 2.14.1 | MIT | https://github.com/bowser-js/bowser |
| brace-expansion | 5.0.12 | MIT | https://github.com/juliangruber/brace-expansion |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | https://github.com/goinstant/buffer-equal-constant-time |
| chalk | 6.0.0 | MIT | https://github.com/chalk/chalk |
| cross-spawn | 7.0.6 | MIT | https://github.com/moxystudio/node-cross-spawn |
| data-uri-to-buffer | 4.0.1 | MIT | https://github.com/TooTallNate/node-data-uri-to-buffer |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| diff | 8.0.4 | BSD-3-Clause | https://github.com/kpdecker/jsdiff |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | https://github.com/Brightspace/node-ecdsa-sig-formatter |
| entities | 8.1.0 | BSD-2-Clause | https://github.com/fb55/entities |
| extend | 3.0.2 | MIT | https://github.com/justmoon/node-extend |
| fast-sha256 | 1.3.0 | Unlicense | https://github.com/dchest/fast-sha256-js |
| fetch-blob | 3.2.0 | MIT | https://github.com/node-fetch/fetch-blob |
| formdata-polyfill | 4.0.10 | MIT | https://github.com/jimmywarting/FormData |
| gaxios | 7.3.1 | Apache-2.0 | https://github.com/googleapis/google-cloud-node/tree/HEAD/core/packages/gaxios |
| gcp-metadata | 8.1.2 | Apache-2.0 | https://github.com/googleapis/google-cloud-node-core/tree/HEAD/packages/gcp-metadata |
| get-east-asian-width | 1.6.0 | MIT | https://github.com/sindresorhus/get-east-asian-width |
| google-auth-library | 10.9.1 | Apache-2.0 | https://github.com/googleapis/google-cloud-node/tree/HEAD/core/packages/google-auth-library-nodejs |
| google-logging-utils | 1.1.3 | Apache-2.0 | https://github.com/googleapis/google-cloud-node-core/tree/HEAD/dev-packages/logging-utils |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| grok-mermaid | 0.2.3 | Apache-2.0 | https://github.com/xl0/grok-mermaid |
| highlight.js | 10.7.3 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| hosted-git-info | 9.0.3 | ISC | https://github.com/npm/hosted-git-info |
| http-proxy-agent | 9.1.0 | MIT | https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/http-proxy-agent |
| https-proxy-agent | 7.0.6 | MIT | https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/https-proxy-agent |
| https-proxy-agent | 9.1.0 | MIT | https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/https-proxy-agent |
| ignore | 7.0.8 | MIT | https://github.com/kaelzhang/node-ignore |
| isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| jiti | 2.7.0 | MIT | https://github.com/unjs/jiti |
| json-bigint | 1.0.0 | MIT | https://github.com/sidorares/json-bigint |
| json-schema-to-ts | 3.1.1 | MIT | https://github.com/ThomasAribart/json-schema-to-ts |
| jwa | 2.0.1 | MIT | https://github.com/brianloveswords/node-jwa |
| jws | 4.0.1 | MIT | https://github.com/brianloveswords/node-jws |
| long | 5.3.2 | Apache-2.0 | https://github.com/dcodeIO/long.js |
| lru-cache | 11.5.3 | BlueOak-1.0.0 | https://github.com/isaacs/node-lru-cache |
| marked | 18.0.11 | MIT | https://github.com/markedjs/marked |
| marked-cjk-friendly | 0.1.2 | MIT | https://github.com/tats-u/markdown-cjk-friendly |
| minimatch | 11.0.3 | BlueOak-1.0.0 | https://github.com/isaacs/minimatch |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| node-domexception | 1.0.0 | MIT | https://github.com/jimmywarting/node-domexception |
| node-fetch | 3.3.2 | MIT | https://github.com/node-fetch/node-fetch |
| openai | 7.19.0 | Apache-2.0 | https://github.com/openai/openai-node |
| p-retry | 4.6.2 | MIT | https://github.com/sindresorhus/p-retry |
| parse5 | 8.0.1 | MIT | https://github.com/inikulin/parse5 |
| partial-json | 0.1.7 | MIT | https://github.com/promplate/partial-json-parser-js |
| path-key | 3.1.1 | MIT | https://github.com/sindresorhus/path-key |
| proper-lockfile | 4.1.2 | MIT | https://github.com/moxystudio/node-proper-lockfile |
| protobufjs | 7.6.6 | BSD-3-Clause | https://github.com/protobufjs/protobuf.js |
| proxy-agent-negotiate | 1.1.0 | MIT | https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/negotiate |
| quickjs-wasi | 3.6.2 | MIT | https://github.com/vercel-labs/quickjs-wasi |
| retry | 0.12.0 | MIT | https://github.com/tim-kos/node-retry |
| retry | 0.13.1 | MIT | https://github.com/tim-kos/node-retry |
| safe-buffer | 5.2.1 | MIT | https://github.com/feross/safe-buffer |
| semver | 7.8.5 | ISC | https://github.com/npm/node-semver |
| shebang-command | 2.0.0 | MIT | https://github.com/kevva/shebang-command |
| shebang-regex | 3.0.0 | MIT | https://github.com/sindresorhus/shebang-regex |
| signal-exit | 3.0.7 | ISC | https://github.com/tapjs/signal-exit |
| standardwebhooks | 1.1.1 | MIT | https://github.com/standard-webhooks/standard-webhooks |
| ts-algebra | 2.0.0 | MIT | https://github.com/ThomasAribart/ts-algebra |
| tslib | 2.8.1 | 0BSD | https://github.com/Microsoft/tslib |
| typebox | 1.3.27 | MIT | https://github.com/sinclairzx81/typebox |
| undici | 8.12.3 | MIT | https://github.com/nodejs/undici |
| undici-types | 7.24.6 | MIT | https://github.com/nodejs/undici |
| web-streams-polyfill | 3.3.3 | MIT | https://github.com/MattiasBuelens/web-streams-polyfill |
| which | 2.0.2 | ISC | https://github.com/isaacs/node-which |
| ws | 8.21.0 | MIT | https://github.com/websockets/ws |
| yaml | 2.9.0 | ISC | https://github.com/eemeli/yaml |

## 2. Packages that the code under `src/ui/` reaches

`npm run build` bundles these packages into the page scripts under `dist/web/`.
The list is read from one esbuild bundle of every module under `src/ui/`, so a
new import cannot be missed, and a package that only the server code uses is
not listed.

| Package | Version | License | Repository |
| --- | --- | --- | --- |
| @preact/signals | 2.11.4 | MIT | https://github.com/preactjs/signals/tree/HEAD/packages/preact |
| @preact/signals-core | 1.14.5 | MIT | https://github.com/preactjs/signals |
| entities | 8.1.0 | BSD-2-Clause | https://github.com/fb55/entities |
| highlight.js | 11.11.1 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| linkify-it | 6.1.0 | MIT | https://github.com/markdown-it/linkify-it |
| markdown-it | 15.0.3 | MIT | https://github.com/markdown-it/markdown-it |
| mdurl | 2.1.0 | MIT | https://github.com/markdown-it/mdurl |
| preact | 11.1.0 | MIT | https://github.com/preactjs/preact |
| punycode.js | 2.3.1 | MIT | https://github.com/mathiasbynens/punycode.js |
| uc.micro | 3.0.0 | MIT | https://github.com/markdown-it/uc.micro |

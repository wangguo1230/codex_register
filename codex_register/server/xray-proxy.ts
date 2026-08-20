// @ts-nocheck
// 兼容门面：调用方无需感知 xray 进程、端口探测和跳板编排的内部拆分。
export {
    isMainHttpServer,
    parseVless,
    startXray,
    stopXray,
    xrayStatus,
} from "./xray-process-manager.js";
export {
    localPortListening,
    localPortListeningAsync,
    waitLocalPort,
} from "./xray-local-port.js";
export {
    isLocalNoAuthSocks,
    isVlessUrl,
    JUMP_PORT_BASE,
    JUMP_RESERVED_PORTS,
    listJumpXrays,
    liveJumpSocks,
    pickXrayBrowserProxy,
    pickJumpPort,
    normalizeJumpBasePort,
    startJumpFleet,
    stopJumpFleet,
    vlessIdentity,
    xrayBrowserCandidatePorts,
} from "./xray-jump-fleet.js";

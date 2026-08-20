// @ts-nocheck
// 解决 Token Worker 与后置充值模块的装配顺序，不暴露可变业务状态。

export function createRechargeServiceBridge() {
    let target = null;

    function bind(service) {
        if (target) throw new Error("recharge service bridge already bound");
        target = service;
    }

    function requireTarget() {
        if (!target) throw new Error("recharge service bridge is not bound");
        return target;
    }

    return {
        bind,
        syncQueue: (...args) => requireTarget().syncQueue(...args),
        attachExportChild: (...args) => requireTarget().attachExportChild(...args),
        log: (...args) => requireTarget().log(...args),
        isBound: () => !!target,
    };
}

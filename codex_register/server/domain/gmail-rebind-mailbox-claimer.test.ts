import assert from "node:assert/strict";
import test from "node:test";
import {createRebindMailboxClaimer} from "./gmail-rebind-mailbox-claimer.js";

function createHarness(overrides = {}) {
    const released = [];
    const unavailable = [];
    const quarantined = [];
    const liveMailboxIds = new Set();
    const claim = createRebindMailboxClaimer({
        listGmailCandidates: async () => [{id: 2}, {id: 3}],
        claimGmail: async (id) => id === 3 ? {id: 3, email: "target@gmail.com"} : null,
        claimMailcom: async () => null,
        explainGmailMiss: async () => "",
        releaseMailbox: async (id) => { released.push(id); },
        markGmailUnavailable: async (ids, reason) => { unavailable.push({ids, reason}); },
        quarantineMailbox: async (id, reason) => { quarantined.push({id, reason}); },
        refreshGoogleState: async () => {},
        probeGmailLogin: async () => ({ok: true}),
        shouldProbeGmailLogin: () => false,
        poolHintOf: () => "，范围=换绑池",
        liveMailboxIds,
        ...overrides,
    });
    return {claim, released, unavailable, quarantined, liveMailboxIds};
}

test("关闭网页登录探测时只做候选原子预占", async () => {
    let probeCalls = 0;
    const claimOptions = [];
    const h = createHarness({
        probeGmailLogin: async () => { probeCalls++; return {ok: true}; },
        claimGmail: async (id, options) => {
            claimOptions.push({id, options});
            return id === 3 ? {id: 3, email: "target@gmail.com"} : null;
        },
    });
    const result = await h.claim({dest: "gmail", pool: {grp: "换绑池"}, excludeIds: [2]});

    assert.equal(result.ok, true);
    assert.equal(result.mailbox.id, 3);
    assert.equal(probeCalls, 0);
    assert.equal(h.liveMailboxIds.has(3), true);
    assert.deepEqual(claimOptions[0].options, {grp: "换绑池", emails: undefined, excludeIds: [2]});
});

test("网页登录出口故障只归还邮箱，不标记废号", async () => {
    const h = createHarness({
        shouldProbeGmailLogin: () => true,
        probeGmailLogin: async () => ({ok: false, step: "login", proxyDead: true, dead: false, error: "tcp timeout"}),
    });
    const result = await h.claim({dest: "gmail"});

    assert.equal(result.ok, false);
    assert.deepEqual(h.released, [3]);
    assert.equal(h.unavailable.length, 0);
    assert.equal(h.liveMailboxIds.has(3), false);
});

test("凭据确定失效时隔离邮箱且不放回池", async () => {
    const h = createHarness({
        shouldProbeGmailLogin: () => true,
        probeGmailLogin: async () => ({ok: false, step: "login", dead: true, error: "Wrong password"}),
    });
    const result = await h.claim({dest: "gmail"});

    assert.equal(result.ok, false);
    assert.equal(h.released.length, 0);
    assert.deepEqual(h.unavailable[0].ids, [3]);
    assert.equal(h.liveMailboxIds.has(3), false);
});

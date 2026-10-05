import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EgressBlockedError, classifyAddress, createGuard, parseIPv6, pinnedLookup } from "../src/ipguard.mjs";

describe("classifyAddress — IPv4", () => {
  const table = [
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.63.255.255", "public"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["100.128.0.0", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local"], // cloud metadata
    ["172.15.255.255", "public"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.0", "public"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "reserved"],
    ["192.167.255.255", "public"],
    ["192.168.0.1", "private"],
    ["192.168.2.201", "private"], // the NAS itself
    ["192.169.0.0", "public"],
    ["198.17.255.255", "public"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["1.1.1.1", "public"],
    ["8.8.8.8", "public"],
    ["104.16.0.1", "public"],
    ["162.159.135.233", "public"],
  ];
  for (const [addr, want] of table) {
    it(`${addr} → ${want}`, () => assert.equal(classifyAddress(addr), want));
  }
});

describe("classifyAddress — IPv6", () => {
  const table = [
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::2", "reserved"],
    ["::127.0.0.1", "reserved"], // deprecated v4-compatible
    ["::ffff:127.0.0.1", "loopback"], // v4-mapped judged by the v4 inside
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:192.168.2.201", "private"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:8.8.8.8", "public"],
    ["0:0:0:0:0:ffff:808:808", "public"],
    ["::ffff:0:8.8.8.8", "reserved"], // IPv4-translated, not mapped
    ["64:ff9b::10.0.0.1", "private"], // NAT64 of a private v4
    ["64:ff9b::8.8.8.8", "public"],
    ["64:ff9b:1::1", "reserved"], // local-use NAT64
    ["100::1", "reserved"], // discard-only
    ["2001::1", "reserved"], // Teredo
    ["2001:2::1", "reserved"], // benchmarking
    ["2001:10::1", "reserved"], // ORCHID
    ["2001:db8::1", "documentation"],
    ["2002:c0a8:2c9::1", "reserved"], // 6to4 of 192.168.2.201
    ["3fff::1", "documentation"],
    ["fc00::1", "private"],
    ["fd12:3456:789a::1", "private"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["fec0::1", "private"],
    ["ff02::1", "multicast"],
    ["ff05::2", "multicast"],
    ["4000::1", "reserved"], // outside 2000::/3
    ["2606:4700:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
    ["2a00:1450:4001:82a::200e", "public"],
    ["[2606:4700::1111]", "public"],
  ];
  for (const [addr, want] of table) {
    it(`${addr} → ${want}`, () => assert.equal(classifyAddress(addr), want));
  }

  it("rejects zone ids and junk as invalid", () => {
    assert.equal(classifyAddress("fe80::1%eth0"), "invalid");
    assert.equal(classifyAddress("localhost"), "invalid");
    assert.equal(classifyAddress("1.2.3"), "invalid");
    assert.equal(classifyAddress("1.2.3.256"), "invalid");
    assert.equal(classifyAddress(""), "invalid");
    assert.equal(classifyAddress("::ffff:1.2.3.999"), "invalid");
  });
});

describe("parseIPv6", () => {
  it("expands :: and embedded IPv4", () => {
    assert.deepEqual(parseIPv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6("1::"), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    assert.deepEqual(parseIPv6("64:ff9b::1.2.3.4"), [0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
    assert.deepEqual(parseIPv6("1:2:3:4:5:6:7.8.9.10"), [1, 2, 3, 4, 5, 6, 0x0708, 0x090a]);
    assert.deepEqual(parseIPv6("fe80::1:2"), [0xfe80, 0, 0, 0, 0, 0, 1, 2]);
    assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("returns null for non-IPv6", () => {
    assert.equal(parseIPv6("1.2.3.4"), null);
    assert.equal(parseIPv6("1:2:3"), null);
    assert.equal(parseIPv6("fe80::1%1"), null);
  });
});

describe("resolvePublic", () => {
  const guardWith = (answers) => {
    const calls = [];
    const g = createGuard({
      resolver: async (host) => {
        calls.push(host);
        if (!(host in answers)) {
          const e = new Error("nx");
          e.code = "ENOTFOUND";
          throw e;
        }
        return answers[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      },
    });
    return { g, calls };
  };

  it("returns every vetted address of a public host", async () => {
    const { g } = guardWith({ "cdn.example": ["93.184.216.34", "2606:2800:220:1::1"] });
    assert.deepEqual(await g.resolvePublic("cdn.example"), [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("blocks when ANY answer is private (rebinding-style mixed answers)", async () => {
    const { g } = guardWith({ "mixed.example": ["93.184.216.34", "192.168.2.201"] });
    await assert.rejects(g.resolvePublic("mixed.example"), (e) => e instanceof EgressBlockedError && e.reason === "private");
  });

  it("blocks names that resolve to loopback / metadata / v4-mapped private", async () => {
    const { g } = guardWith({
      "localhost.example": ["127.0.0.1"],
      "meta.example": ["169.254.169.254"],
      "mapped.example": ["::ffff:10.0.0.1"],
    });
    await assert.rejects(g.resolvePublic("localhost.example"), /loopback/);
    await assert.rejects(g.resolvePublic("meta.example"), /link-local/);
    await assert.rejects(g.resolvePublic("mapped.example"), /private/);
  });

  it("checks IP literals without DNS, brackets included", async () => {
    const { g, calls } = guardWith({});
    assert.deepEqual(await g.resolvePublic("8.8.8.8"), [{ address: "8.8.8.8", family: 4 }]);
    await assert.rejects(g.resolvePublic("[::1]"), EgressBlockedError);
    await assert.rejects(g.resolvePublic("10.1.1.1"), EgressBlockedError);
    await assert.rejects(g.resolvePublic("fe80::1%25eth0"), EgressBlockedError);
    assert.equal(calls.length, 0);
  });

  it("surfaces DNS failures as plain errors (not as blocks)", async () => {
    const { g } = guardWith({});
    await assert.rejects(g.resolvePublic("nope.example"), (e) => !(e instanceof EgressBlockedError) && e.code === "ENOTFOUND");
    await assert.rejects(g.resolvePublic(""), EgressBlockedError);
  });

  it("resolves through the real system resolver by default", async () => {
    const g = createGuard();
    await assert.rejects(g.resolvePublic("localhost"), (e) => e instanceof EgressBlockedError && e.reason === "loopback");
  });
});

describe("pinnedLookup", () => {
  const vetted = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1::1", family: 6 },
  ];
  it("answers only with vetted addresses, for any hostname", () => {
    const lookup = pinnedLookup(vetted);
    lookup("evil.example", { all: true }, (err, list) => {
      assert.equal(err, null);
      assert.deepEqual(list, vetted);
    });
    lookup("evil.example", {}, (err, address, family) => {
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
    });
    lookup("evil.example", { family: 6 }, (err, address) => assert.equal(address, "2606:2800:220:1::1"));
    lookup("evil.example", (err, address) => assert.equal(address, "93.184.216.34"));
  });
});

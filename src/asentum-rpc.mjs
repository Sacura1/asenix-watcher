export async function fetchJson(baseUrl, path, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function maybeJson(baseUrl, path, timeoutMs = 8000, fallback = null) {
  try {
    return await fetchJson(baseUrl, path, timeoutMs);
  } catch {
    return fallback;
  }
}

async function fetchReady(baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/ready`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function blockTimestampMs(block) {
  const value = block?.header?.timestamp ?? block?.timestamp;
  if (!value) return null;
  try {
    const numeric = Number(BigInt(value));
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  } catch {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
}

function toNumber(value, fallback = 0) {
  try {
    return Number(BigInt(value));
  } catch {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}

function blockHeight(block, fallback) {
  return toNumber(
    block?.height ?? block?.header?.height ?? block?.number ?? block?.header?.number,
    fallback,
  );
}

function findAddressInObject(value, address) {
  if (!address || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.toLowerCase() === address;
  if (Array.isArray(value)) return value.some((item) => findAddressInObject(item, address));
  if (typeof value === 'object') {
    return Object.values(value).some((item) => findAddressInObject(item, address));
  }
  return false;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function scanRecentBlocks(rpcUrl, height, windowSize, timeoutMs) {
  const start = Math.max(0, height - windowSize + 1);
  const heights = Array.from({ length: height - start + 1 }, (_, index) => start + index);
  const blocks = await mapLimit(heights, 8, async (number) => {
    const block = await maybeJson(rpcUrl, `/block/${number}`, timeoutMs);
    if (!block) return null;
    return { ...block, __height: number };
  });
  return blocks.filter(Boolean);
}

function summarizeBlocks(blocks, address) {
  const latest = blocks.at(-1) ?? null;
  const latestTime = blockTimestampMs(latest);
  const proposerCounts = new Map();
  let proposedByAddress = 0;
  let relatedTxCount = 0;
  let successfulRelatedTxCount = 0;
  let lastProposedBlock = null;

  for (const block of blocks) {
    const proposer = block.header?.proposer?.toLowerCase();
    const height = blockHeight(block, block.__height);
    if (proposer) {
      proposerCounts.set(proposer, (proposerCounts.get(proposer) ?? 0) + 1);
      if (address && proposer === address) {
        proposedByAddress += 1;
        lastProposedBlock = {
          height,
          timestampMs: blockTimestampMs(block),
        };
      }
    }

    for (const receipt of block.receipts ?? []) {
      const sender = receipt.sender?.toLowerCase();
      const recipient = receipt.recipient?.toLowerCase();
      if (address && (sender === address || recipient === address)) {
        relatedTxCount += 1;
        if (receipt.success) successfulRelatedTxCount += 1;
      }
    }
  }

  return {
    latestBlockAgeSec: latestTime ? Math.max(0, Math.round((Date.now() - latestTime) / 1000)) : null,
    lastProposedBlock,
    proposedByAddress,
    relatedTxCount,
    successfulRelatedTxCount,
    topProposers: [...proposerCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([proposer, blocksProposed]) => ({ blocksProposed, proposer })),
  };
}

export async function collectChainSnapshot({
  address = '',
  rpcUrl,
  timeoutMs = 8000,
  windowSize = 128,
}) {
  const normalizedAddress = address.toLowerCase();
  const [chain, health, ready, metadata, validators] = await Promise.all([
    fetchJson(rpcUrl, '/chain', timeoutMs),
    maybeJson(rpcUrl, '/health', timeoutMs),
    fetchReady(rpcUrl, timeoutMs),
    maybeJson(rpcUrl, '/metadata', timeoutMs),
    maybeJson(rpcUrl, '/validators', timeoutMs),
  ]);

  const height = toNumber(chain.height);
  const [balance, blocks] = await Promise.all([
    normalizedAddress ? maybeJson(rpcUrl, `/balance/${normalizedAddress}`, timeoutMs) : null,
    scanRecentBlocks(rpcUrl, height, windowSize, timeoutMs),
  ]);

  return {
    balance,
    chain: {
      chainId: chain.chainId,
      height,
      latestProposer: chain.latestHeader?.proposer ?? null,
      mempoolSize: Number(chain.mempoolSize ?? 0),
    },
    health,
    isValidator: findAddressInObject(validators, normalizedAddress),
    metadata,
    ready,
    rpcUrl,
    validatorSet: validators,
    window: {
      blocksRequested: windowSize,
      blocksScanned: blocks.length,
      ...summarizeBlocks(blocks, normalizedAddress),
    },
  };
}

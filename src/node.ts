import { createPublicClient, http } from "viem";
import { katana } from "viem/chains";

export const publicClient = createPublicClient({
  chain: katana,
  transport: http('https://rpc.katana.network/')
})

async function debugTx() {
  const receipt = await publicClient.getTransactionReceipt({
    hash: "0xa2ce9e6430dd15e9ff44814ef96564b9aee49762c59ab07078d8593f29709750",
  });

  console.log("status:", receipt.status);
  console.log("logs count:", receipt.logs.length);

  const emitters = [...new Set(receipt.logs.map(l => l.address.toLowerCase()))];
  console.log("log emitters:", emitters);

  const TRANSFER_TOPIC0 =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  const transfers = receipt.logs.filter(l => l.topics?.[0] === TRANSFER_TOPIC0);
  console.log("erc20 transfers:", transfers);
}

debugTx();
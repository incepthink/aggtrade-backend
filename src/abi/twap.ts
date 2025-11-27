// Orbs TWAP Contract ABI for SushiSwap Limit Orders
export const twapABI = [
  {
    name: "ask",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "ask",
        type: "tuple",
        components: [
          { name: "exchange", type: "address" },
          { name: "srcToken", type: "address" },
          { name: "dstToken", type: "address" },
          { name: "srcAmount", type: "uint256" },
          { name: "srcBidAmount", type: "uint256" },
          { name: "dstMinAmount", type: "uint256" },
          { name: "deadline", type: "uint32" },
          { name: "bidDelay", type: "uint32" },
          { name: "fillDelay", type: "uint32" },
          { name: "data", type: "bytes" }
        ]
      }
    ],
    outputs: [{ name: "id", type: "uint256" }]
  }
] as const
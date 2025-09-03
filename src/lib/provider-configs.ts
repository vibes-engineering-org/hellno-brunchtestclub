import { type Address, maxUint256 } from "viem";
import type { ProviderConfig } from "~/lib/types";
import { MANIFOLD_EXTENSION_ABI, MANIFOLD_ERC721_EXTENSION_ABI, MANIFOLD_ERC1155_EXTENSION_ABI, KNOWN_CONTRACTS, PRICE_DISCOVERY_ABI, MINT_ABI, THIRDWEB_OPENEDITONERC721_ABI, THIRDWEB_ERC1155_EXTENSION_ABI, THIRDWEB_NATIVE_TOKEN } from "~/lib/nft-standards";

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  manifold: {
    name: "manifold",
    extensionAddresses: [
      KNOWN_CONTRACTS.manifoldExtension, // Known Manifold extension
    ],
    priceDiscovery: {
      abis: [MANIFOLD_EXTENSION_ABI],
      functionNames: ["MINT_FEE"],
      requiresInstanceId: true
    },
    mintConfig: {
      abi: MANIFOLD_EXTENSION_ABI,
      functionName: "mint",
      buildArgs: (params) => [
        params.contractAddress,
        BigInt(params.instanceId || "0"),
        Number(params.tokenId || "0"),
        params.merkleProof || [],
        params.recipient
      ],
      calculateValue: (mintFee, params) => {
        // For Manifold, value is just the mint fee
        // The actual NFT cost might be in ERC20
        return mintFee;
      }
    },
    requiredParams: ["contractAddress", "chainId"],
    supportsERC20: true
  },
  
  opensea: {
    name: "opensea",
    priceDiscovery: {
      abis: [PRICE_DISCOVERY_ABI],
      functionNames: ["mintPrice", "price", "publicMintPrice"]
    },
    mintConfig: {
      abi: MINT_ABI,
      functionName: "mint",
      buildArgs: (params) => [BigInt(params.amount || 1)],
      calculateValue: (price, params) => price * BigInt(params.amount || 1)
    },
    requiredParams: ["contractAddress", "chainId"],
    supportsERC20: false
  },

  zora: {
    name: "zora",
    priceDiscovery: {
      abis: [PRICE_DISCOVERY_ABI],
      functionNames: ["mintPrice", "price"]
    },
    mintConfig: {
      abi: MINT_ABI,
      functionName: "mint",
      buildArgs: (params) => [params.recipient, BigInt(params.amount || 1)],
      calculateValue: (price, params) => price * BigInt(params.amount || 1)
    },
    requiredParams: ["contractAddress", "chainId"],
    supportsERC20: false
  },

  generic: {
    name: "generic",
    priceDiscovery: {
      abis: [PRICE_DISCOVERY_ABI],
      functionNames: ["mintPrice", "price", "MINT_PRICE", "getMintPrice"]
    },
    mintConfig: {
      abi: MINT_ABI,
      functionName: "mint",
      buildArgs: (params) => [BigInt(params.amount || 1)],
      calculateValue: (price, params) => price * BigInt(params.amount || 1)
    },
    requiredParams: ["contractAddress", "chainId"],
    supportsERC20: false
  },

  nfts2me: {
    name: "nfts2me",
    priceDiscovery: {
      // For nfts2me, we need a custom ABI with mintFee function
      abis: [[{
        inputs: [{ name: "amount", type: "uint256" }],
        name: "mintFee",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function"
      }]],
      functionNames: ["mintFee"],
      // Custom logic to handle mintFee with amount parameter
      requiresAmountParam: true
    },
    mintConfig: {
      // NFTs2Me mint(amount) expects the number of NFTs to mint
      // For minting 1 NFT, pass 1. Payment is via msg.value.
      abi: [{
        inputs: [{ name: "amount", type: "uint256" }],
        name: "mint",
        outputs: [],
        stateMutability: "payable",
        type: "function"
      }],
      functionName: "mint",
      buildArgs: (params) => [BigInt(params.amount || 1)],
      calculateValue: (price, params) => price * BigInt(params.amount || 1)
    },
    requiredParams: ["contractAddress", "chainId"],
    supportsERC20: false
  },

  thirdweb: {
    name: "thirdweb",
    priceDiscovery: {
      abis: [THIRDWEB_OPENEDITONERC721_ABI],
      functionNames: ["claimCondition", "getClaimConditionById"],
      requiresInstanceId: false
    },
    mintConfig: {
      abi: THIRDWEB_OPENEDITONERC721_ABI,
      functionName: "claim",
      buildArgs: (params) => {
        // This will be overridden by getProviderConfig for thirdweb
        // when contractInfo with claimCondition is available
        return [
          params.recipient || params.contractAddress, // _receiver
          BigInt(params.amount || 1), // _quantity
          THIRDWEB_NATIVE_TOKEN, // _currency (default to ETH)
          BigInt(0), // _pricePerToken (default to 0)
          {
            proof: params.merkleProof || [],
            quantityLimitPerWallet: maxUint256,
            pricePerToken: maxUint256,
            currency: "0x0000000000000000000000000000000000000000"
          }, // _allowlistProof
          "0x" // _data
        ];
      },
      calculateValue: (price, params) => {
        // This will be overridden by getProviderConfig for thirdweb
        // Default assumes native token payment
        return price * BigInt(params.amount || 1);
      }
    },
    requiredParams: ["contractAddress", "chainId"],
    supportsERC20: true
  }
};

/**
 * Get the correct Manifold ABI based on contract type
 */
function getManifoldABI(contractInfo?: any) {
  if (!contractInfo) {
    console.log("[Manifold ABI] No contract info provided, defaulting to ERC721 ABI");
    return MANIFOLD_ERC721_EXTENSION_ABI;
  }
  
  // Use contract type detection to select ABI
  if (contractInfo.isERC721) {
    console.log("[Manifold ABI] Using ERC721 ABI (14 fields in getClaim)");
    return MANIFOLD_ERC721_EXTENSION_ABI;
  } else if (contractInfo.isERC1155) {
    console.log("[Manifold ABI] Using ERC1155 ABI (12 fields in getClaim)");
    return MANIFOLD_ERC1155_EXTENSION_ABI;
  } else {
    console.log("[Manifold ABI] Contract type unknown, defaulting to ERC721 ABI");
    return MANIFOLD_ERC721_EXTENSION_ABI;
  }
}

// Helper to get config by provider name
export function getProviderConfig(provider: string, contractInfo?: any, params?: any): ProviderConfig {
  const baseConfig = PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS.generic;
  
  // For Manifold, we need to inject the correct ABI based on contract type
  if (provider === "manifold") {
    const manifoldABI = getManifoldABI(contractInfo);
    
    return {
      ...baseConfig,
      priceDiscovery: {
        ...baseConfig.priceDiscovery,
        abis: [manifoldABI]
      },
      mintConfig: {
        ...baseConfig.mintConfig,
        abi: manifoldABI
      }
    };
  }
  
  // For thirdweb, we need to handle different contract types
  if (provider === "thirdweb") {
    // Handle ERC1155 Extensions with proper ABI and parameters
    if (contractInfo?.isERC1155) {
      console.log("[Provider Config] Using Thirdweb ERC1155 Extension configuration");
      
      // For the specific hardcoded contract, use exact parameters from successful transaction
      if (params?.contractAddress?.toLowerCase() === "0xcd0bafa3bba1b32869343fb69d2778daf4412181") {
        console.log("[Provider Config] Using exact claim parameters from successful transaction");
        return {
          ...baseConfig,
          mintConfig: {
            abi: THIRDWEB_ERC1155_EXTENSION_ABI,
            functionName: "claim",
            buildArgs: (params) => {
              console.group("🔧 [PROVIDER CONFIG] Building Thirdweb hardcoded args");
              console.log("Params received:", params);
              
              const args = [
                params.recipient, // _receiver
                BigInt(0), // _tokenId = 0 (from successful transaction)
                BigInt(params.amount || 1), // _quantity
                THIRDWEB_NATIVE_TOKEN, // _currency (native XDAI)
                BigInt("1000000000000000000"), // _pricePerToken (1 XDAI)
                {
                  proof: [], // empty proof array
                  quantityLimitPerWallet: BigInt(0), // 0 limit
                  pricePerToken: maxUint256, // max uint256
                  currency: "0x0000000000000000000000000000000000000000" // zero address
                }, // _allowlistProof
                "0x" // _data (empty)
              ];
              
              console.log("Built hardcoded args:", args);
              console.groupEnd();
              return args;
            },
            calculateValue: (price, params) => {
              return BigInt("1000000000000000000") * BigInt(params.amount || 1); // 1 XDAI per token
            }
          },
          priceDiscovery: {
            abis: [THIRDWEB_ERC1155_EXTENSION_ABI],
            functionNames: ["claimCondition"],
            requiresInstanceId: false
          }
        };
      }
      
      return {
        ...baseConfig,
        mintConfig: {
          abi: THIRDWEB_ERC1155_EXTENSION_ABI,
          functionName: "claim",
          buildArgs: (params) => {
            // For ERC1155 Extensions, try to get price from hardcoded value or use 0
            const pricePerToken = params.contractAddress?.toLowerCase() === "0xcd0bafa3bba1b32869343fb69d2778daf4412181" 
              ? BigInt("1000000000000000000") // 1 XDAI
              : contractInfo.claimCondition?.pricePerToken || BigInt(0);
            const currency = contractInfo.claimCondition?.currency || THIRDWEB_NATIVE_TOKEN;
            
            return [
              params.recipient, // _receiver
              BigInt(params.tokenId || "1"), // _tokenId (use provided token ID, default to 1)
              BigInt(params.amount || 1), // _quantity
              currency, // _currency
              pricePerToken, // _pricePerToken
              {
                proof: params.merkleProof || [],
                quantityLimitPerWallet: maxUint256,
                pricePerToken: maxUint256,
                currency: "0x0000000000000000000000000000000000000000"
              }, // _allowlistProof
              "0x" // _data
            ];
          },
          calculateValue: (price, params) => {
            const currency = contractInfo.claimCondition?.currency;
            
            if (!currency || currency.toLowerCase() === THIRDWEB_NATIVE_TOKEN.toLowerCase()) {
              return price * BigInt(params.amount || 1);
            }
            return BigInt(0);
          }
        },
        priceDiscovery: {
          abis: [THIRDWEB_ERC1155_EXTENSION_ABI],
          functionNames: ["claimCondition"],
          requiresInstanceId: false
        }
      };
    }
    
    // Handle ERC721 Drop contracts (existing logic)
    if (contractInfo?.claimCondition) {
      return {
        ...baseConfig,
        mintConfig: {
          ...baseConfig.mintConfig,
          buildArgs: (params) => {
            const pricePerToken = contractInfo.claimCondition.pricePerToken || BigInt(0);
            const currency = contractInfo.claimCondition.currency || THIRDWEB_NATIVE_TOKEN;
            
            return [
              params.recipient || params.contractAddress, // _receiver
              BigInt(params.amount || 1), // _quantity
              currency, // _currency
              pricePerToken, // _pricePerToken
              {
                proof: params.merkleProof || [],
                quantityLimitPerWallet: maxUint256,
                pricePerToken: maxUint256,
                currency: "0x0000000000000000000000000000000000000000"
              }, // _allowlistProof
              "0x" // _data
            ];
          },
          calculateValue: (price, params) => {
            const currency = contractInfo.claimCondition?.currency;
            
            if (!currency || currency.toLowerCase() === THIRDWEB_NATIVE_TOKEN.toLowerCase()) {
              return price * BigInt(params.amount || 1);
            }
            return BigInt(0);
          }
        }
      };
    }
  }
  
  return baseConfig;
}
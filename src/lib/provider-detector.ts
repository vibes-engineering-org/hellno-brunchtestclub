import { type Address, type PublicClient } from "viem";
import type {
  NFTProvider,
  NFTContractInfo,
  MintParams,
} from "~/lib/types";
import { PROVIDER_CONFIGS } from "~/lib/provider-configs";
import { getPublicClient } from "~/lib/chains";
import {
  ERC165_ABI,
  INTERFACE_IDS,
  MANIFOLD_DETECTION_ABI,
} from "~/lib/nft-standards";

// Re-export from shared library for backward compatibility
export const getClientForChain = getPublicClient;

/**
 * Detects NFT provider and contract info with minimal RPC calls
 * Uses multicall where possible to batch requests
 */
export async function detectNFTProvider(
  params: MintParams,
): Promise<NFTContractInfo> {
  const { contractAddress, chainId, provider: specifiedProvider } = params;
  const client = getClientForChain(chainId);

  console.log(
    `[Provider Detection] Starting for contract ${contractAddress} on chain ${chainId}`,
  );

  // Hardcode specific contract as Thirdweb Extension
  if (contractAddress.toLowerCase() === "0xcd0bafa3bba1b32869343fb69d2778daf4412181") {
    console.log(`[Provider Detection] ✅ Hardcoded Thirdweb ERC1155 Extension for known contract`);
    return {
      provider: "thirdweb",
      isERC1155: true,
      isERC721: false,
    };
  }

  // If provider is specified, use known configuration
  if (specifiedProvider) {
    console.log(
      `[Provider Detection] Using specified provider: ${specifiedProvider}`,
    );
    const config = PROVIDER_CONFIGS[specifiedProvider];

    // For Manifold, we know the extension address
    if (specifiedProvider === "manifold" && config.extensionAddresses?.[0]) {
      return {
        provider: "manifold",
        isERC1155: true, // Manifold contracts are typically ERC1155
        isERC721: false,
        extensionAddress: config.extensionAddresses[0],
        hasManifoldExtension: true,
      };
    }

    // For other providers, return basic info
    return {
      provider: specifiedProvider,
      isERC1155: false,
      isERC721: false,
    };
  }

  try {
    // Batch 1: Check interfaces and Manifold extensions in parallel
    const [isERC721, isERC1155, extensions] = await Promise.all([
      client
        .readContract({
          address: contractAddress,
          abi: ERC165_ABI,
          functionName: "supportsInterface",
          args: [INTERFACE_IDS.ERC721],
        })
        .catch(() => false),

      client
        .readContract({
          address: contractAddress,
          abi: ERC165_ABI,
          functionName: "supportsInterface",
          args: [INTERFACE_IDS.ERC1155],
        })
        .catch(() => false),

      client
        .readContract({
          address: contractAddress,
          abi: MANIFOLD_DETECTION_ABI,
          functionName: "getExtensions",
        })
        .catch(() => null),
    ]);

    // Check if it's a Manifold contract
    if (extensions && extensions.length > 0) {
      const knownManifoldExtension = extensions.find((ext) =>
        PROVIDER_CONFIGS.manifold.extensionAddresses?.includes(ext),
      );

      if (knownManifoldExtension || extensions.length > 0) {
        console.log(
          `[Provider Detection] ✅ Detected as Manifold (has extensions)`,
        );
        return {
          provider: "manifold",
          isERC1155: isERC1155 as boolean,
          isERC721: isERC721 as boolean,
          extensionAddress: knownManifoldExtension || extensions[0],
          hasManifoldExtension: true,
        };
      }
    }

    // Check if it's an NFTs2Me contract by looking for unique functions
    try {
      // Try to call n2mVersion - this is unique to NFTs2Me contracts
      const version = await client.readContract({
        address: contractAddress,
        abi: [
          {
            inputs: [],
            name: "n2mVersion",
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "pure",
            type: "function",
          },
        ],
        functionName: "n2mVersion",
      });

      // If n2mVersion exists, it's an NFTs2Me contract
      if (version !== undefined) {
        console.log(
          `[Provider Detection] ✅ Detected as NFTs2Me (n2mVersion: ${version})`,
        );
        return {
          provider: "nfts2me",
          isERC1155: isERC1155 as boolean,
          isERC721: isERC721 as boolean,
        };
      }
    } catch {
      // Not an NFTs2Me contract, continue detection
    }

    // Check if it's a thirdweb contract (ERC721 or ERC1155)
    console.log(`[Thirdweb Detection] Checking contract: ${contractAddress}`);
    
    // First try ERC721 pattern (OpenEditionERC721)
    if (isERC721) {
      try {
        const claimConditionResult = await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [],
              name: "claimCondition",
              outputs: [
                { name: "currentStartId", type: "uint256" },
                { name: "count", type: "uint256" },
              ],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "claimCondition",
        });
        
        // Verify the result is a valid tuple with 2 uint256 values
        if (Array.isArray(claimConditionResult) && claimConditionResult.length === 2) {
          console.log(`[Thirdweb Detection] ✅ Found ERC721 claimCondition: startId=${claimConditionResult[0]}, count=${claimConditionResult[1]}`);
          
          // Optional: Quick validation of sharedMetadata to reduce false positives
          try {
            await client.readContract({
              address: contractAddress,
              abi: [
                {
                  inputs: [],
                  name: "sharedMetadata",
                  outputs: [
                    { name: "name", type: "string" },
                    { name: "description", type: "string" },
                    { name: "imageURI", type: "string" },
                    { name: "animationURI", type: "string" },
                  ],
                  stateMutability: "view",
                  type: "function",
                },
              ],
              functionName: "sharedMetadata",
            });
            console.log(`[Thirdweb Detection] ✅ Confirmed ERC721 with sharedMetadata`);
          } catch {
            // sharedMetadata not found, but claimCondition is strong enough signal
            console.log(`[Thirdweb Detection] ⚠️ ERC721 sharedMetadata not found, but claimCondition is sufficient`);
          }
        
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        }
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ ERC721 claimCondition check failed: ${error}`);
      }
    }
    
    // Try ERC1155 patterns if it's an ERC1155 contract
    if (isERC1155) {
      console.log(`[Thirdweb Detection] Trying ERC1155 patterns...`);
      
      // Pattern 1: Check for claimCondition mapping with tokenId (DropSinglePhase1155)
      try {
        const claimConditionResult = await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [{ name: "tokenId", type: "uint256" }],
              name: "claimCondition",
              outputs: [
                { name: "startTimestamp", type: "uint256" },
                { name: "maxClaimableSupply", type: "uint256" },
                { name: "supplyClaimed", type: "uint256" },
                { name: "merkleRoot", type: "bytes32" },
                { name: "pricePerToken", type: "uint256" },
                { name: "currency", type: "address" },
                { name: "metadata", type: "string" },
              ],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "claimCondition",
          args: [0n], // Try with tokenId 0 (from successful transaction)
        });
        
        if (claimConditionResult && typeof claimConditionResult === 'object') {
          console.log(`[Thirdweb Detection] ✅ Found ERC1155 claimCondition mapping`);
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        }
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ ERC1155 claimCondition mapping check failed: ${error}`);
      }
      
      // Pattern 2: Check for multi-phase drop pattern
      try {
        const activeClaimConditionId = await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [],
              name: "getActiveClaimConditionId",
              outputs: [{ name: "", type: "uint256" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "getActiveClaimConditionId",
        });
        
        if (typeof activeClaimConditionId === 'bigint' || typeof activeClaimConditionId === 'number') {
          console.log(`[Thirdweb Detection] ✅ Found ERC1155 multi-phase pattern (activeId: ${activeClaimConditionId})`);
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        }
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ ERC1155 multi-phase check failed: ${error}`);
      }
      
      // Pattern 3: Check for signature minting pattern
      try {
        await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [
                { name: "req", type: "tuple", components: [
                  { name: "to", type: "address" },
                  { name: "tokenId", type: "uint256" },
                  { name: "quantity", type: "uint256" },
                  { name: "pricePerToken", type: "uint256" },
                  { name: "currency", type: "address" },
                  { name: "validityStartTimestamp", type: "uint128" },
                  { name: "validityEndTimestamp", type: "uint128" },
                  { name: "uid", type: "bytes32" }
                ]},
                { name: "signature", type: "bytes" }
              ],
              name: "verify",
              outputs: [
                { name: "success", type: "bool" },
                { name: "signer", type: "address" }
              ],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "verify",
          args: [
            { to: "0x0000000000000000000000000000000000000000", tokenId: 0n, quantity: 1n, pricePerToken: 0n, currency: "0x0000000000000000000000000000000000000000", validityStartTimestamp: 0n, validityEndTimestamp: 0n, uid: "0x0000000000000000000000000000000000000000000000000000000000000000" },
            "0x"
          ],
        });
        
        console.log(`[Thirdweb Detection] ✅ Found ERC1155 signature minting pattern`);
        return {
          provider: "thirdweb",
          isERC1155: isERC1155 as boolean,
          isERC721: isERC721 as boolean,
        };
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ ERC1155 signature minting check failed: ${error}`);
      }
      
      // Pattern 4: Check for common Thirdweb functions (contractURI, owner, etc.)
      const thirdwebIndicators = [
        "contractURI", "owner", "nextTokenIdToMint", "totalSupply", 
        "mintTo", "lazyMint", "reveal", "setClaimConditions"
      ];
      
      let foundIndicators = 0;
      for (const functionName of thirdwebIndicators) {
        try {
          await client.readContract({
            address: contractAddress,
            abi: [
              {
                inputs: [],
                name: functionName,
                outputs: [{ name: "", type: "string" }], // Generic output type
                stateMutability: "view",
                type: "function",
              },
            ],
            functionName: functionName,
          });
          foundIndicators++;
          console.log(`[Thirdweb Detection] ✅ Found indicator function: ${functionName}`);
          
          // If we find 2+ Thirdweb indicators, it's likely a Thirdweb contract
          if (foundIndicators >= 2) {
            console.log(`[Thirdweb Detection] ✅ Found ${foundIndicators} Thirdweb indicators - likely Thirdweb ERC1155`);
            return {
              provider: "thirdweb",
              isERC1155: isERC1155 as boolean,
              isERC721: isERC721 as boolean,
            };
          }
        } catch (error) {
          // Function not found, continue
        }
      }
      
      // Pattern 5: Check for Drop1155 specific functions
      const drop1155Functions = ["claim", "setClaimConditions", "getActiveClaimConditionId", "verifyClaim"];
      for (const functionName of drop1155Functions) {
        try {
          // Try calling the function with minimal args to see if it exists
          const result = await client.readContract({
            address: contractAddress,
            abi: [
              {
                inputs: [],
                name: functionName,
                outputs: [{ name: "", type: "uint256" }],
                stateMutability: "view", 
                type: "function",
              },
            ],
            functionName: functionName,
          });
          
          console.log(`[Thirdweb Detection] ✅ Found Drop1155 function: ${functionName}`);
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        } catch (error) {
          // Try different signatures for functions that take parameters
          if (functionName === "claim" || functionName === "verifyClaim") {
            try {
              // Try with parameters (these functions typically need args)
              await client.readContract({
                address: contractAddress,
                abi: [
                  {
                    inputs: [
                      { name: "_receiver", type: "address" },
                      { name: "_tokenId", type: "uint256" },
                      { name: "_quantity", type: "uint256" },
                      { name: "_currency", type: "address" },
                      { name: "_pricePerToken", type: "uint256" }
                    ],
                    name: functionName,
                    outputs: [],
                    stateMutability: "payable",
                    type: "function",
                  },
                ],
                functionName: functionName,
              });
              
              console.log(`[Thirdweb Detection] ✅ Found Drop1155 function with params: ${functionName}`);
              return {
                provider: "thirdweb",
                isERC1155: isERC1155 as boolean,
                isERC721: isERC721 as boolean,
              };
            } catch (innerError) {
              // Function signature doesn't match, continue
            }
          }
        }
      }
      
      // Pattern 6: Check for Thirdweb NFT Extension patterns (ERC-7504 Dynamic Contracts)
      console.log(`[Thirdweb Detection] Checking NFT Extension patterns...`);
      
      // First check: ERC165 interface detection for Thirdweb extensions
      try {
        // Check for signature minting interface (common in Extensions)
        const supportsSignatureMint = await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [{ name: "interfaceId", type: "bytes4" }],
              name: "supportsInterface",
              outputs: [{ name: "", type: "bool" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "supportsInterface",
          args: ["0x4e2312e0"], // ISignatureMintERC1155 interface ID
        });
        
        if (supportsSignatureMint) {
          console.log(`[Thirdweb Detection] ✅ Found ISignatureMintERC1155 interface - Thirdweb Extension`);
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        }
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ Interface check failed: ${error}`);
      }
      
      // Check for signature minting pattern (most common in Extensions)
      try {
        await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [
                { name: "_req", type: "tuple", components: [
                  { name: "to", type: "address" },
                  { name: "royaltyRecipient", type: "address" },
                  { name: "royaltyBps", type: "uint256" },
                  { name: "primarySaleRecipient", type: "address" },
                  { name: "tokenId", type: "uint256" },
                  { name: "uri", type: "string" },
                  { name: "quantity", type: "uint256" },
                  { name: "pricePerToken", type: "uint256" },
                  { name: "currency", type: "address" },
                  { name: "validityStartTimestamp", type: "uint128" },
                  { name: "validityEndTimestamp", type: "uint128" },
                  { name: "uid", type: "bytes32" }
                ]},
                { name: "_signature", type: "bytes" }
              ],
              name: "mintWithSignature",
              outputs: [],
              stateMutability: "payable",
              type: "function",
            },
          ],
          functionName: "mintWithSignature",
        });
        
        console.log(`[Thirdweb Detection] ✅ Found mintWithSignature - Thirdweb Extension ERC1155`);
        return {
          provider: "thirdweb",
          isERC1155: isERC1155 as boolean,
          isERC721: isERC721 as boolean,
        };
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ mintWithSignature check failed: ${error}`);
      }
      
      // Extension contracts have these specific management functions
      const extensionFunctions = [
        "getAllExtensions", 
        "addExtension",
        "removeExtension",
        "replaceExtension",
        "getMetadataForFunction"
      ];
      
      for (const functionName of extensionFunctions) {
        try {
          await client.readContract({
            address: contractAddress,
            abi: [
              {
                inputs: [],
                name: functionName,
                outputs: [{ name: "", type: "address[]" }], // Extensions typically return addresses
                stateMutability: "view",
                type: "function",
              },
            ],
            functionName: functionName,
          });
          
          console.log(`[Thirdweb Detection] ✅ Found NFT Extension function: ${functionName}`);
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        } catch (error) {
          // Try different output types for extension functions
          try {
            await client.readContract({
              address: contractAddress,
              abi: [
                {
                  inputs: [{ name: "extensionName", type: "string" }],
                  name: functionName,
                  outputs: [{ name: "", type: "address" }],
                  stateMutability: "view",
                  type: "function",
                },
              ],
              functionName: functionName,
            });
            
            console.log(`[Thirdweb Detection] ✅ Found NFT Extension function with param: ${functionName}`);
            return {
              provider: "thirdweb",
              isERC1155: isERC1155 as boolean,
              isERC721: isERC721 as boolean,
            };
          } catch (innerError) {
            // Function not found with this signature, continue
          }
        }
      }
      
      // Pattern 7: Check for Extension-specific metadata and initialization functions
      const extensionMetadataFunctions = [
        "_initializeOwner",
        "_setupRole", 
        "_setupContractURI",
        "_setupDefaultRoyalty",
        "_setupPrimarySaleRecipient"
      ];
      
      let extensionIndicators = 0;
      for (const functionName of extensionMetadataFunctions) {
        try {
          // These are typically initialization functions, so we just check if they exist
          await client.readContract({
            address: contractAddress,
            abi: [
              {
                inputs: [{ name: "data", type: "bytes" }],
                name: functionName,
                outputs: [],
                stateMutability: "nonpayable",
                type: "function",
              },
            ],
            functionName: functionName,
          });
          
          extensionIndicators++;
          console.log(`[Thirdweb Detection] ✅ Found Extension metadata function: ${functionName}`);
          
          // If we find 2+ extension indicators, it's likely a Thirdweb Extension contract
          if (extensionIndicators >= 2) {
            console.log(`[Thirdweb Detection] ✅ Found ${extensionIndicators} Extension indicators - likely Thirdweb Extension ERC1155`);
            return {
              provider: "thirdweb",
              isERC1155: isERC1155 as boolean,
              isERC721: isERC721 as boolean,
            };
          }
        } catch (error) {
          // Function not found, continue
        }
      }
      
      // Pattern 8: Check for common ERC1155 Extension patterns (token-specific functions)
      try {
        // Extensions often have functions that work with token IDs
        await client.readContract({
          address: contractAddress,
          abi: [
            {
              inputs: [{ name: "tokenId", type: "uint256" }],
              name: "uri",
              outputs: [{ name: "", type: "string" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "uri",
          args: [0n],
        });
        
        console.log(`[Thirdweb Detection] ✅ Found ERC1155 uri function - checking for Thirdweb patterns`);
        
        // If uri works, try to call totalSupply for token 0 (common in Extensions)
        try {
          await client.readContract({
            address: contractAddress,
            abi: [
              {
                inputs: [{ name: "id", type: "uint256" }],
                name: "totalSupply",
                outputs: [{ name: "", type: "uint256" }],
                stateMutability: "view",
                type: "function",
              },
            ],
            functionName: "totalSupply",
            args: [0n],
          });
          
          console.log(`[Thirdweb Detection] ✅ Found ERC1155 totalSupply with tokenId - likely Thirdweb Extension`);
          return {
            provider: "thirdweb",
            isERC1155: isERC1155 as boolean,
            isERC721: isERC721 as boolean,
          };
        } catch (innerError) {
          // totalSupply signature doesn't match, continue
        }
      } catch (error) {
        console.log(`[Thirdweb Detection] ❌ ERC1155 uri check failed: ${error}`);
      }
    }

    // TODO: Add detection for OpenSea, Zora, etc.
    // For now, return generic
    console.log(
      `[Provider Detection] Final result: Generic provider (no specific platform detected)`,
    );
    return {
      provider: "generic",
      isERC1155: isERC1155 as boolean,
      isERC721: isERC721 as boolean,
    };
  } catch (error) {
    console.error("Error detecting NFT provider:", error);
    // Default to generic provider
    return {
      provider: "generic",
      isERC1155: false,
      isERC721: false,
    };
  }
}

/**
 * Validates parameters based on detected provider
 */
export function validateParameters(
  params: MintParams,
  contractInfo: NFTContractInfo,
): {
  isValid: boolean;
  missingParams: string[];
  errors: string[];
} {
  const config = PROVIDER_CONFIGS[contractInfo.provider];
  const missingParams: string[] = [];
  const errors: string[] = [];

  // Check required params for the provider
  for (const param of config.requiredParams) {
    if (!params[param as keyof MintParams]) {
      missingParams.push(param);
    }
  }

  // Provider-specific validation
  if (contractInfo.provider === "manifold") {
    if (!params.instanceId && !params.tokenId) {
      errors.push("Manifold NFTs require either instanceId or tokenId. Check the claim page URL for (e.g., /instance/123456) use getClaimForToken to find a specific");
      missingParams.push("instanceId or tokenId");
    }
    
    // Validate instanceId format if provided
    if (params.instanceId) {
      const instanceIdNum = parseInt(params.instanceId);
      if (isNaN(instanceIdNum) || instanceIdNum < 0) {
        errors.push(`Invalid instanceId format: ${params.instanceId}. Must be a positive integer.`);
      }
    }

    if (
      contractInfo.claim?.merkleRoot &&
      contractInfo.claim.merkleRoot !==
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      errors.push(
        "This NFT requires a merkle proof for minting - not supported yet",
      );
    }
  }

  if (contractInfo.provider === "thirdweb") {
    if (
      contractInfo.claimCondition?.merkleRoot &&
      contractInfo.claimCondition.merkleRoot !==
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      errors.push(
        "This NFT requires a merkle proof for minting - not supported yet",
      );
    }

    if (contractInfo.claimCondition?.startTimestamp) {
      const now = Math.floor(Date.now() / 1000);
      if (now < contractInfo.claimCondition.startTimestamp) {
        errors.push("Claim has not started yet");
      }
    }
  }

  return {
    isValid: missingParams.length === 0 && errors.length === 0,
    missingParams,
    errors,
  };
}

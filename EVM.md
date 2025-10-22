# ZKSync SSO on EIP-7702 + EIP-4337 for EVM


## Local Development

1. Install workspace dependencies with `forge soldeer install`.
2. Build the project with `forge build`.

To run the integration tests:

1. Install dependencies with `pnpm install`
2. Run the local development node with `pnpm anvil`
3. In a separate terminal, run the bundler with `pnpm bundler`
4. Deploy all contracts and a test account with `pnpm deploy-test`
5. Run the EVM workflow with `pnpm exec tsx ./test/evm/index.ts`

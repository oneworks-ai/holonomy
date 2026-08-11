import { NetworkRuleContractError, normalizeNetworkRuleSet } from '../../adapters/node/src/network-rule-contract.mjs'
import { serviceError } from './errors.mjs'

export const admitNetworkRuleSet = value => {
  try {
    return normalizeNetworkRuleSet(value)
  } catch (error) {
    if (error instanceof NetworkRuleContractError && error.code === 'network.rules_limit') {
      throw serviceError('service.limit_exceeded', 'Network rule set exceeds its limit')
    }
    throw serviceError('service.invalid_request', 'Network rule set is invalid')
  }
}

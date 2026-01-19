import { subscribe } from 'nostr-tools/relay';
import { SimplePool } from 'nostr-tools/pool';

// List of public Nostr relays
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.current.fyi'
];

let pool = new SimplePool();
let relayConnections = new Map();
let subscriptions = new Map();

/**
 * Add or connect to relays
 */
export async function addRelays(relayUrls = DEFAULT_RELAYS) {
  for (const url of relayUrls) {
    if (!relayConnections.has(url)) {
      try {
        await pool.ensureRelay(url);
        relayConnections.set(url, true);
        console.log(`Connected to relay: ${url}`);
      } catch (error) {
        console.error(`Failed to connect to relay ${url}:`, error);
      }
    }
  }
}

/**
 * Ensure relay connection is established
 */
export async function ensureRelayConnection(relayUrl = DEFAULT_RELAYS[0]) {
  if (!relayConnections.has(relayUrl)) {
    await addRelays([relayUrl]);
  }
  return relayConnections.get(relayUrl);
}

/**
 * Crawl available relays
 */
export async function crawlRelays() {
  return DEFAULT_RELAYS;
}

/**
 * Ensure connections to multiple relays
 */
export async function ensureConnections(relayUrls = DEFAULT_RELAYS) {
  await addRelays(relayUrls);
}

/**
 * Publish an event to all connected relays
 */
export async function publishEvent(event) {
  const relayUrls = Array.from(relayConnections.keys());
  if (relayUrls.length === 0) {
    await addRelays();
  }
  
  try {
    const publishPromises = Array.from(relayConnections.keys()).map(url => 
      pool.publish(url, event).catch(err => {
        console.error(`Failed to publish to ${url}:`, err);
      })
    );
    await Promise.all(publishPromises);
    console.log('Event published to all relays');
  } catch (error) {
    console.error('Error publishing event:', error);
  }
}

/**
 * Subscribe to events with a filter
 */
export async function subscribeToEvents(filter, onEvent, subscriptionId = 'default') {
  if (relayConnections.size === 0) {
    await addRelays();
  }

  try {
    const relayUrls = Array.from(relayConnections.keys());
    
    const subscription = pool.subscribeMany(relayUrls, [filter], {
      onevent: (event) => onEvent(event),
      onclose: () => console.log(`Subscription ${subscriptionId} closed`),
      oneose: () => console.log(`Subscription ${subscriptionId} received all events`)
    });

    subscriptions.set(subscriptionId, subscription);
    console.log(`Subscribed with filter:`, filter);
    return subscriptionId;
  } catch (error) {
    console.error('Error subscribing to events:', error);
  }
}

/**
 * Unsubscribe from events
 */
export async function unsubscribeFromEvents(subscriptionId = 'default') {
  const subscription = subscriptions.get(subscriptionId);
  if (subscription) {
    subscription.close();
    subscriptions.delete(subscriptionId);
    console.log(`Unsubscribed: ${subscriptionId}`);
  }
}

/**
 * Close all relay connections
 */
export async function closeAllConnections() {
  subscriptions.forEach(sub => sub.close());
  subscriptions.clear();
  
  relayConnections.forEach((_, url) => {
    pool.close(url);
  });
  relayConnections.clear();
  
  console.log('Closed all relay connections');
}

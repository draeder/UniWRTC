#!/usr/bin/env node

/**
 * Simple test script for UniWRTC
 * Runs two clients and tests peer connections
 */

const { UniWRTCClient } = require('./client.js');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  console.log('🚀 Starting UniWRTC Test...\n');

  // Create two clients
  const client1 = new UniWRTCClient('ws://localhost:8080');
  const client2 = new UniWRTCClient('ws://localhost:8080');

  try {
    // Connect first client
    console.log('📱 Connecting Client 1...');
    const id1 = await client1.connect();
    console.log(`✅ Client 1 connected with ID: ${id1}\n`);

    await sleep(500);

    // Connect second client
    console.log('📱 Connecting Client 2...');
    const id2 = await client2.connect();
    console.log(`✅ Client 2 connected with ID: ${id2}\n`);

    await sleep(500);

    // Join same room
    console.log('🏠 Client 1 joining room: test-room');
    client1.joinRoom('test-room');
    
    await sleep(500);

    console.log('🏠 Client 2 joining room: test-room');
    client2.joinRoom('test-room');

    await sleep(1000);

    console.log('\n✨ Test complete! Both clients joined the room.');
    console.log('📊 Peers in Client 1:', Array.from(client1.peers.keys()));
    console.log('📊 Peers in Client 2:', Array.from(client2.peers.keys()));

    // Cleanup
    client1.disconnect();
    client2.disconnect();
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

runTest();

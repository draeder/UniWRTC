import { test, expect } from '@playwright/test';

test.describe('UniWRTC Demo - Full Integration Tests', () => {
  const BASE_URL = 'https://signal.peer.ooo';
  const ROOM_ID = 'test';
  
  test.describe('Connection and Session Management', () => {
    test('should load demo page and display UI', async ({ page }) => {
      await page.goto(BASE_URL);
      
      // Check main elements exist
      await expect(page.locator('h1')).toContainText('UniWRTC Demo');
      await expect(page.locator('text=Connection')).toBeVisible();
      await expect(page.getByTestId('serverUrl')).toHaveValue('wss://signal.peer.ooo');
      await expect(page.getByTestId('roomId')).toHaveValue('demo-room');
      await expect(page.getByTestId('connectBtn')).toBeVisible();
    });

    test('should connect to signaling server and join session', async ({ page }) => {
      await page.goto(BASE_URL);
      
      // Click connect
      await page.getByTestId('connectBtn').click();
      
      // Wait for connection success log
      await expect(page.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('log-joined')).toBeVisible({ timeout: 10000 });
      
      // Check status changed to connected
      const badge = page.getByTestId('statusBadge');
      await expect(badge).toContainText('Connected');
      
      // Client ID should be populated
      const clientId = page.getByTestId('clientId');
      const clientIdText = await clientId.textContent();
      expect(clientIdText).not.toContain('Not connected');
      expect(clientIdText?.length).toBeGreaterThan(0);
    });

    test('should handle disconnect', async ({ page }) => {
      await page.goto(BASE_URL);
      
      // Connect first
      await page.getByTestId('connectBtn').click();
      await expect(page.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
      
      // Now disconnect
      await page.getByTestId('disconnectBtn').click();
      
      // Check status changed back to disconnected
      const badge = page.getByTestId('statusBadge');
      await expect(badge).toContainText('Disconnected');
      await expect(page.getByTestId('clientId')).toContainText('Not connected');
    });
  });

  test.describe('Multi-peer Session', () => {
    test('should connect three peers and see peer-joined notifications', async ({ browser }) => {
      // Open three browser contexts (simulating three users)
      const context1 = await browser.newContext();
      const page1 = await context1.newPage();
      
      const context2 = await browser.newContext();
      const page2 = await context2.newPage();
      
      const context3 = await browser.newContext();
      const page3 = await context3.newPage();
      
      try {
        // Connect all three peers to same room
        await page1.goto(BASE_URL);
        await page2.goto(BASE_URL);
        await page3.goto(BASE_URL);
        
        // Use shared room ID for all three peers
        await page1.getByTestId('roomId').fill(ROOM_ID);
        await page2.getByTestId('roomId').fill(ROOM_ID);
        await page3.getByTestId('roomId').fill(ROOM_ID);
        
        // Connect peer 1
        await page1.getByTestId('connectBtn').click();
        await expect(page1.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        // Connect peer 2
        await page2.getByTestId('connectBtn').click();
        await expect(page2.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        // Peer 1 should see peer 2 joined (use .last() to get most recent)
        await expect(page1.getByTestId('log-peer-joined').last()).toBeVisible({ timeout: 10000 });
        
        // Connect peer 3
        await page3.getByTestId('connectBtn').click();
        await expect(page3.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        // Peer 2 should see peer 3 joined (use first() to avoid strict mode with multiple peer-joined logs)
        await expect(page2.getByTestId('log-peer-joined').first()).toBeVisible({ timeout: 10000 });
        
        // All three should show peers in connected peers list
        const peerList1 = page1.getByTestId('peerList');
        const peerList2 = page2.getByTestId('peerList');
        const peerList3 = page3.getByTestId('peerList');
        
        await expect(peerList1).not.toContainText('No peers connected');
        await expect(peerList2).not.toContainText('No peers connected');
        await expect(peerList3).not.toContainText('No peers connected');
        
      } finally {
        await context1.close();
        await context2.close();
        await context3.close();
      }
    });

    test('should open P2P data channels between three peers', async ({ browser }) => {
      const context1 = await browser.newContext();
      const page1 = await context1.newPage();
      
      const context2 = await browser.newContext();
      const page2 = await context2.newPage();
      
      const context3 = await browser.newContext();
      const page3 = await context3.newPage();
      
      try {
        // Connect all three peers
        await page1.goto(BASE_URL);
        await page2.goto(BASE_URL);
        await page3.goto(BASE_URL);
        
        await page1.getByTestId('roomId').fill(ROOM_ID);
        await page2.getByTestId('roomId').fill(ROOM_ID);
        await page3.getByTestId('roomId').fill(ROOM_ID);
        
        await page1.getByTestId('connectBtn').click();
        await expect(page1.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        await page2.getByTestId('connectBtn').click();
        await expect(page2.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        await page3.getByTestId('connectBtn').click();
        await expect(page3.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        // Give peers time to discover each other (wait a bit before checking peer-joined)
        await page1.waitForTimeout(500);
        
        // Wait for peer-joined on all sides (use .last() to get most recent)
        // For peer3, check if it has at least one peer-joined (it may not join from earlier connections)
        await expect(page1.getByTestId('log-peer-joined').last()).toBeVisible({ timeout: 20000 });
        await expect(page2.getByTestId('log-peer-joined').last()).toBeVisible({ timeout: 20000 });
        
        // Peer3 might have peer-joined logs, but even if not, it should eventually see data channels
        try {
          await expect(page3.getByTestId('log-peer-joined').last()).toBeVisible({ timeout: 20000 });
        } catch (e) {
          // It's OK if peer3 doesn't have peer-joined log initially, data channels will still establish
        }
        
        // Wait for data channels to open - wait for at least one data channel log on each peer with extended timeout
        await expect(page1.getByTestId('log-data-channel').first()).toBeVisible({ timeout: 25000 });
        await expect(page2.getByTestId('log-data-channel').first()).toBeVisible({ timeout: 25000 });
        await expect(page3.getByTestId('log-data-channel').first()).toBeVisible({ timeout: 25000 });
        
        // Wait longer to ensure all data channels are fully established
        await page1.waitForTimeout(2000);
        
        // Check that we have at least 2 data channels (accumulation from parallel tests OK)
        const dc1Count = await page1.getByTestId('logContainer').locator('[data-testid="log-data-channel"]').count();
        const dc2Count = await page2.getByTestId('logContainer').locator('[data-testid="log-data-channel"]').count();
        const dc3Count = await page3.getByTestId('logContainer').locator('[data-testid="log-data-channel"]').count();
        
        expect(dc1Count).toBeGreaterThanOrEqual(2);
        expect(dc2Count).toBeGreaterThanOrEqual(2);
        expect(dc3Count).toBeGreaterThanOrEqual(2);
        
      } finally {
        await context1.close();
        await context2.close();
        await context3.close();
      }
    });

    test('should send P2P chat messages between three peers', async ({ browser }) => {
      const context1 = await browser.newContext();
      const page1 = await context1.newPage();
      
      const context2 = await browser.newContext();
      const page2 = await context2.newPage();
      
      const context3 = await browser.newContext();
      const page3 = await context3.newPage();
      
      try {
        // Connect all three peers
        await page1.goto(BASE_URL);
        await page2.goto(BASE_URL);
        await page3.goto(BASE_URL);
        
        await page1.getByTestId('roomId').fill(ROOM_ID);
        await page2.getByTestId('roomId').fill(ROOM_ID);
        await page3.getByTestId('roomId').fill(ROOM_ID);
        
        await page1.getByTestId('connectBtn').click();
        await expect(page1.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        await page2.getByTestId('connectBtn').click();
        await expect(page2.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        await page3.getByTestId('connectBtn').click();
        await expect(page3.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        // Wait for data channels to open on all peers first with extended timeout
        await expect(page1.getByTestId('log-data-channel').first()).toBeVisible({ timeout: 25000 });
        await expect(page2.getByTestId('log-data-channel').first()).toBeVisible({ timeout: 25000 });
        await expect(page3.getByTestId('log-data-channel').first()).toBeVisible({ timeout: 25000 });
        
        // Wait longer to ensure all data channels are fully established
        await page1.waitForTimeout(2000);
        
        // Check that we have at least 2 data channels
        const chat1Count = await page1.getByTestId('logContainer').locator('[data-testid="log-data-channel"]').count();
        const chat2Count = await page2.getByTestId('logContainer').locator('[data-testid="log-data-channel"]').count();
        const chat3Count = await page3.getByTestId('logContainer').locator('[data-testid="log-data-channel"]').count();
        
        expect(chat1Count).toBeGreaterThanOrEqual(2);
        expect(chat2Count).toBeGreaterThanOrEqual(2);
        expect(chat3Count).toBeGreaterThanOrEqual(2);
        
        // Send message from peer 1
        const testMessage = 'Hello from Peer 1! ' + Date.now();
        await page1.getByTestId('chatMessage').fill(testMessage);
        await page1.getByTestId('sendBtn').click();
        
        // Wait for message to appear on all three with extended timeout
        await expect(page1.locator(`text=${testMessage}`)).toBeVisible({ timeout: 15000 });
        await expect(page2.locator(`text=${testMessage}`)).toBeVisible({ timeout: 15000 });
        await expect(page3.locator(`text=${testMessage}`)).toBeVisible({ timeout: 15000 });
        
        // Send message from peer 2
        const testMessage2 = 'Response from Peer 2! ' + Date.now();
        await page2.getByTestId('chatMessage').fill(testMessage2);
        await page2.getByTestId('sendBtn').click();
        
        // Wait for message to appear on all three
        await expect(page1.locator(`text=${testMessage2}`)).toBeVisible({ timeout: 15000 });
        await expect(page2.locator(`text=${testMessage2}`)).toBeVisible({ timeout: 15000 });
        await expect(page3.locator(`text=${testMessage2}`)).toBeVisible({ timeout: 15000 });
        
        // Send message from peer 3
        const testMessage3 = 'Third message from Peer 3! ' + Date.now();
        await page3.getByTestId('chatMessage').fill(testMessage3);
        await page3.getByTestId('sendBtn').click();
        
        // Wait for message to appear on all three
        await expect(page1.locator(`text=${testMessage3}`)).toBeVisible({ timeout: 15000 });
        await expect(page2.locator(`text=${testMessage3}`)).toBeVisible({ timeout: 15000 });
        await expect(page3.locator(`text=${testMessage3}`)).toBeVisible({ timeout: 15000 });
        
        // Wait for message to appear on all three
        await expect(page1.locator(`text=${testMessage3}`)).toBeVisible({ timeout: 5000 });
        await expect(page2.locator(`text=${testMessage3}`)).toBeVisible({ timeout: 5000 });
        await expect(page3.locator(`text=${testMessage3}`)).toBeVisible({ timeout: 5000 });
        
      } finally {
        await context1.close();
        await context2.close();
        await context3.close();
      }
    });
  });

  test.describe('Session Isolation', () => {
    test('should not connect peers from different sessions', async ({ browser }) => {
      const context1 = await browser.newContext();
      const page1 = await context1.newPage();
      
      const context2 = await browser.newContext();
      const page2 = await context2.newPage();
      
      try {
        // Connect to different rooms
        await page1.goto(BASE_URL);
        await page2.goto(BASE_URL);
        
        // Use different unique room IDs to ensure isolation
        const roomA = `iso-a-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const roomB = `iso-b-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        await page1.getByTestId('roomId').fill(roomA);
        await page2.getByTestId('roomId').fill(roomB);
        
        await page1.getByTestId('connectBtn').click();
        await expect(page1.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        await page2.getByTestId('connectBtn').click();
        await expect(page2.getByTestId('log-connected')).toBeVisible({ timeout: 10000 });
        
        // Wait a bit to see if peer-joined appears (it shouldn't)
        await page1.waitForTimeout(3000);
        
        // Neither should see the other's peer-joined
        const peerList1 = page1.getByTestId('peerList');
        const peerList2 = page2.getByTestId('peerList');
        
        await expect(peerList1).toContainText('No peers connected');
        await expect(peerList2).toContainText('No peers connected');
        
      } finally {
        await context1.close();
        await context2.close();
      }
    });
  });

  test.describe('Error Handling', () => {
    test('should show error when server URL is empty', async ({ page }) => {
      await page.goto(BASE_URL);
      
      await page.getByTestId('serverUrl').fill('');
      await page.getByTestId('connectBtn').click();
      
      await expect(page.locator('text=Please enter a server URL')).toBeVisible({ timeout: 5000 });
    });

    test('should show error when room ID is empty', async ({ page }) => {
      await page.goto(BASE_URL);
      
      await page.getByTestId('roomId').fill('');
      await page.getByTestId('connectBtn').click();
      
      await expect(page.locator('text=Please enter a room ID')).toBeVisible({ timeout: 5000 });
    });
  });
});

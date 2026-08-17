require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { Server } = require('socket.io');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// OneSignal: send push notification directly via REST API
function sendOneSignalPush(playerIds, message, heading = 'Order Update', data = null) {
  return new Promise((resolve, reject) => {
    const payload = {
      app_id: process.env.ONESIGNAL_APP_ID,
      include_player_ids: playerIds,
      contents: { en: message },
      headings: { en: heading },
    };
    if (data) {
      payload.data = data;
      if (data.orderId) {
        payload.android_group = data.orderId;
        payload.collapse_id = data.orderId;
      }
    }
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'onesignal.com',
      port: 443,
      path: '/api/v1/notifications',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${process.env.ONESIGNAL_REST_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ... skipped ...

// In app.post('/api/orders') handler:
// Broadcast new order to Admin Kitchen Dashboard instantly

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request Logger - logs every incoming request
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`[${now}] ${req.method} ${req.url} (Content-Length: ${req.headers['content-length'] || 'none'}, Origin: ${req.headers['origin'] || 'none'})`);
  next();
});

// --- ROUTES ---

// 1. Menu & Categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany();
    console.log(`  -> Returning ${categories.length} categories`);
    res.json(categories);
  } catch (error) {
    console.error('  -> ERROR fetching categories:', error.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.post('/api/categories', async (req, res) => {
  const { name, icon } = req.body;
  try {
    const newCategory = await prisma.category.create({
      data: { 
        name, 
        icon: icon || 'fast-food-outline' 
      }
    });
    io.emit('menu_updated');
    res.status(201).json(newCategory);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Delete any menu items belonging to this category first (to avoid FK errors)
    // Actually, since menu items have order items, this might get complicated if there are orders.
    // For safety, let's just attempt to delete the category. If it has menu items, Prisma will throw,
    // which is the correct safe behavior.
    await prisma.category.delete({
      where: { id }
    });
    io.emit('menu_updated');
    res.status(200).json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete category (Ensure it is empty first)' });
  }
});

app.get('/api/menu', async (req, res) => {
  try {
    const menuItems = await prisma.menuItem.findMany({
      include: { category: true }
    });
    console.log(`  -> Returning ${menuItems.length} menu items`);
    res.json(menuItems);
  } catch (error) {
    console.error('  -> ERROR fetching menu:', error.message);
    res.status(500).json({ error: 'Failed to fetch menu items' });
  }
});

app.post('/api/menu', async (req, res) => {
  const { name, description, price, imageUrl, categoryId, rating, isVeg } = req.body;
  console.log(`  -> POST /api/menu payload: name=${name}, categoryId=${categoryId}, price=${price}, isVeg=${isVeg}, imageUrl length=${imageUrl ? imageUrl.length : 'MISSING'}`);
  try {
    const newItem = await prisma.menuItem.create({
      data: {
        name,
        description,
        price: typeof price === 'string' ? parseFloat(price) : price,
        imageUrl,
        categoryId,
        rating: rating || 0,
        isVeg: isVeg === undefined ? true : isVeg
      }
    });
    console.log(`  -> SUCCESS: Created menu item id=${newItem.id}`);
    res.status(201).json(newItem);
  } catch (error) {
    console.error('  -> ERROR creating menu item:', error.message);
    console.error('  -> Full error:', error);
    res.status(500).json({ error: 'Failed to create menu item', detail: error.message });
  }
});

app.delete('/api/menu/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`  -> DELETE /api/menu/${id}`);
  try {
    // Delete related OrderItems first to satisfy foreign key constraints
    await prisma.orderItem.deleteMany({
      where: { menuItemId: id }
    });
    // Now delete the actual menu item
    await prisma.menuItem.delete({ where: { id } });
    console.log(`  -> SUCCESS: Deleted menu item id=${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('  -> ERROR deleting menu item:', error.message);
    res.status(500).json({ error: 'Failed to delete menu item', detail: error.message });
  }
});

// 2. Orders
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: { items: { include: { menuItem: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.get('/api/orders/table/:tableNumber/latest', async (req, res) => {
  const { tableNumber } = req.params;
  try {
    const order = await prisma.order.findFirst({
      where: { 
        tableNumber,
        status: { notIn: ['Paid', 'Completed', 'Cancelled'] }
      },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { menuItem: true } } }
    });
    res.json(order || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch table latest order' });
  }
});

app.get('/api/orders/customer/:customerId/latest', async (req, res) => {
  const { customerId } = req.params;
  try {
    const order = await prisma.order.findFirst({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { menuItem: true } } }
    });
    res.json(order || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customer latest order' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { tableNumber, customerName, customerId, subtotal, totalPrice, items } = req.body;
  try {
    const order = await prisma.order.create({
      data: {
        tableNumber,
        customerName,
        customerId,
        subtotal,
        totalPrice,
        status: 'Pending',
        items: {
          create: items.map(item => ({
            menuItemId: item.menuItem.id,
            quantity: item.quantity,
            specialInstructions: item.specialInstructions
          }))
        }
      },
      include: { items: { include: { menuItem: true } } }
    });
    
    // Broadcast new order to Admin Kitchen Dashboard instantly
    io.emit('new_order', order);
    
    // Send Push Notification to all registered Admin devices (Admins have customerId = null)
    try {
      const devices = await prisma.device.findMany({
        where: { customerId: null }
      });
      const playerIds = devices.map(d => d.playerId).filter(Boolean);
      
      if (playerIds.length > 0) {
        const itemNames = order.items.map(i => `${i.quantity}x ${i.menuItem.name}`).join(', ');
        try {
          sendOneSignalPush(
            playerIds,
            `Table ${order.tableNumber} - ${order.customerName || 'Guest'}\nItems: ${itemNames}`,
            `New Order! ($${order.totalPrice.toFixed(2)})`,
            { orderId: order.id }
          ).then(result => {
            const fs = require('fs');
            fs.appendFileSync('devices.log', `[PUSH ADMIN] Response: ${JSON.stringify(result)}\n`);
          }).catch(notifError => {
            const fs = require('fs');
            fs.appendFileSync('devices.log', `[PUSH ADMIN] ERROR: ${notifError}\n`);
          });
        } catch (notifError) {
          console.error('  -> Failed to send push to admins:', notifError);
        }
      }
    } catch (notifError) {
      console.error('  -> Failed to send push notification to admins', notifError);
    }

    res.status(201).json(order);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.put('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  try {
    let paymentStatusUpdate = undefined;
    if (status === 'Order Placed') {
      paymentStatusUpdate = 'paid';
    }

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: { 
        status, 
        paymentStatus: paymentStatusUpdate !== undefined ? paymentStatusUpdate : undefined,
        completedAt: status === 'Completed' || status === 'Served' ? new Date() : undefined 
      },
      include: { items: { include: { menuItem: true } } }
    });

    // Broadcast status change to Kitchen Dashboard
    io.emit('order_updated', updatedOrder);

    // If order is Accepted or Ready, send Push Notification to customer
    if (status === 'Accepted' || status === 'Ready') {
      console.log(`[PUSH] Status changed to "${status}" for order ${id}`);
      console.log(`[PUSH] Order customerId: ${updatedOrder.customerId || 'NULL - customer has no ID stored!'}`);

      if (!updatedOrder.customerId) {
        console.warn(`[PUSH] SKIPPING: No customerId on order. Customer may not have logged in properly.`);
      } else {
        // Find ALL devices for this customer (they may have multiple browsers)
        const devices = await prisma.device.findMany({
          where: { customerId: updatedOrder.customerId }
        });

        console.log(`[PUSH] Found ${devices.length} device(s) for customerId "${updatedOrder.customerId}"`);
        devices.forEach(d => console.log(`[PUSH]   -> playerId: ${d.playerId}`));

        if (devices.length === 0) {
          console.warn(`[PUSH] SKIPPING: No devices registered for this customer. They may not have granted notification permission.`);
        } else {
          const playerIds = devices.map(d => d.playerId);
          let message = '';
          if (status === 'Accepted') message = 'Your order has been accepted.';
          if (status === 'Ready') message = 'Your order is ready!';

          console.log(`[PUSH] Sending notification: "${message}" to playerIds: ${JSON.stringify(playerIds)}`);

          try {
            sendOneSignalPush(playerIds, message, 'Order Status', { orderId: updatedOrder.id })
              .then(result => {
                const fs = require('fs');
                fs.appendFileSync('devices.log', `[PUSH CUST] Response: ${JSON.stringify(result)}\n`);
              })
              .catch(pushErr => {
                const fs = require('fs');
                fs.appendFileSync('devices.log', `[PUSH CUST] ERROR: ${pushErr.message || pushErr}\n`);
              });
          } catch (pushErr) {
            console.error(`[PUSH] ERROR from OneSignal:`, pushErr.message || pushErr);
          }
        }
      }
    }

    res.json(updatedOrder);
  } catch (error) {
    console.error('Failed to update order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

app.put('/api/orders/:id/payment', async (req, res) => {
  const { id } = req.params;
  const { paymentStatus } = req.body;
  
  try {
    const updatedOrder = await prisma.order.update({
      where: { id },
      data: { paymentStatus },
      include: { items: { include: { menuItem: true } } }
    });

    io.emit('order_updated', updatedOrder);
    res.json(updatedOrder);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update payment status' });
  }
});

// 4. Tables API (QR Codes)
app.get('/api/tables', async (req, res) => {
  try {
    const tables = await prisma.table.findMany();
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

app.post('/api/tables', async (req, res) => {
  try {
    const table = await prisma.table.create({ data: req.body });
    io.emit('tables_updated');
    res.status(201).json(table);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create table' });
  }
});

app.put('/api/tables/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const table = await prisma.table.update({ where: { id }, data: req.body });
    io.emit('tables_updated');
    res.json(table);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update table' });
  }
});

app.delete('/api/tables/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.table.delete({ where: { id } });
    io.emit('tables_updated');
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

// OneSignal Device Registration
const fs = require('fs');
app.post('/api/devices', async (req, res) => {
  const logMsg = `\n[${new Date().toISOString()}] /api/devices CALLED\nBody: ${JSON.stringify(req.body)}\n`;
  console.log(logMsg);
  fs.appendFileSync('devices.log', logMsg);

  const { playerId, customerId } = req.body;
  if (!playerId) {
    fs.appendFileSync('devices.log', 'ERROR: Missing playerId\n');
    return res.status(400).json({ error: 'playerId is required' });
  }

  try {
    const data = { playerId };
    // Only link customerId if it's provided and not a string "null" or "undefined"
    if (customerId && customerId !== 'null' && customerId !== 'undefined') {
      data.customerId = customerId;
    }

    const device = await prisma.device.upsert({
      where: { playerId },
      update: data,
      create: data,
    });
    
    console.log('SUCCESS: Device saved to DB:', device);
    res.json(device);
  } catch (error) {
    console.error('ERROR saving device to DB:', error);
    fs.appendFileSync('devices.log', `ERROR saving device to DB: ${error.message}\n`);
    res.status(500).json({ error: 'Failed to register device', details: error.message, stack: error.stack });
  }
});

const path = require('path');

// --- SOCKET.IO HANDLING ---
io.on('connection', (socket) => {
  console.log('A client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

app.get('/api/debug-devices', async (req, res) => {
  try {
    const devices = await prisma.device.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    res.json({ count: devices.length, devices });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug-log', (req, res) => {
  try {
    const fs = require('fs');
    if (fs.existsSync('devices.log')) {
      res.type('text/plain').send(fs.readFileSync('devices.log', 'utf8'));
    } else {
      res.send('Log file does not exist yet.');
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/api/telemetry', express.json(), (req, res) => {
  try {
    const fs = require('fs');
    const logLine = `[${new Date().toISOString()}] ${req.body.message}\n`;
    fs.appendFileSync('telemetry.log', logLine);
    res.send({ success: true });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// Debug page for OneSignal diagnostics
app.get('/debug-push', (req, res) => {
  res.sendFile(path.join(__dirname, 'onesignal-debug.html'));
});

// Serve Angular App with no-cache headers to prevent aggressive Safari caching
const noCacheOptions = {
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
};
app.use(express.static(path.join(__dirname, 'www'), noCacheOptions));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'www', 'index.html'));
  } else {
    next();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

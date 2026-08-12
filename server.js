require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { Server } = require('socket.io');
const http = require('http');
const OneSignal = require('onesignal-node');
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

// OneSignal Client Initialization
const oneSignalClient = new OneSignal.Client(
  process.env.ONESIGNAL_APP_ID,
  process.env.ONESIGNAL_REST_API_KEY
);

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
      data: { name, icon }
    });
    res.status(201).json(newCategory);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create category' });
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
    
    // Send Push Notification to all registered Admin devices
    try {
      const devices = await prisma.device.findMany();
      const playerIds = devices.map(d => d.playerId).filter(Boolean);
      
      if (playerIds.length > 0) {
        const itemNames = order.items.map(i => `${i.quantity}x ${i.menuItem.name}`).join(', ');
        const notification = {
          contents: {
            'en': `Table ${order.tableNumber} - ${order.customerName || 'Guest'}\nItems: ${itemNames}`,
          },
          headings: {
            'en': `New Order! ($${order.totalPrice.toFixed(2)})`
          },
          include_subscription_ids: playerIds,
        };
        await oneSignalClient.createNotification(notification);
        console.log(`  -> Sent new order push notification to ${playerIds.length} admins`);
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
    // Workaround for the compiled Admin APK: The APK's collectPayment function 
    // attempts to set payment to paid (which was empty) and then sets status to 'Order Placed'.
    // We intercept this and update the paymentStatus here.
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

    // If order is Ready, send Push Notification to customer
    if (status === 'Ready' && updatedOrder.customerId) {
      const device = await prisma.device.findFirst({
        where: { id: updatedOrder.customerId }
      });
      
      if (device && device.playerId) {
        const notification = {
          contents: {
            'en': `Your order for Table ${updatedOrder.tableNumber} is ready for pickup!`,
          },
          include_subscription_ids: [device.playerId],
        };
        await oneSignalClient.createNotification(notification);
      }
    }

    res.json(updatedOrder);
  } catch (error) {
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

// 3. Devices (For Push Notifications)
app.post('/api/devices', async (req, res) => {
  const { playerId } = req.body;
  try {
    const device = await prisma.device.upsert({
      where: { playerId },
      update: {},
      create: { playerId }
    });
    res.json(device);
  } catch (error) {
    res.status(500).json({ error: 'Failed to register device' });
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

// Serve Angular App
app.use(express.static(path.join(__dirname, 'www')));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'www', 'index.html'));
  } else {
    next();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

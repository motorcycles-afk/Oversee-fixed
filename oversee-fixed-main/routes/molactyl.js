const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const axios = require('axios');
const { db } = require('../handlers/db.js');
const config = require('../config.json');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const saltRounds = 10;
const multer = require('multer');
const path = require('path')
const fs = require('node:fs')
const {logAudit} = require('../handlers/auditlog.js');
const nodemailer = require('nodemailer');
const { sendTestEmail } = require('../handlers/email.js');
const { isAuthenticated } = require('../handlers/auth.js');

const earners = {}; // Use an object to track earners by email - MOVED OUTSIDE

router.get("/dashboard", isAuthenticated, async (req, res) => {
    if (!req.user) return res.redirect('/');
    let instances = [];

    if (req.query.see === "other") {
        let allInstances = await db.get('instances') || [];
        instances = allInstances.filter(instance => instance.User !== req.user.userId);
    } else {
        const userId = req.user.userId;
        const users = await db.get('users') || [];
        const authenticatedUser = users.find(user => user.userId === userId);
        instances = await db.get(req.user.userId + '_instances') || [];
        const subUserInstances = authenticatedUser.accessTo || [];
        for (const instanceId of subUserInstances) {
            const instanceData = await db.get(`${instanceId}_instance`);
            if (instanceData) {
                instances.push(instanceData);
            }
        }
    }
    const announcement = await db.get('announcement');
    const announcement_data = {
      title: 'Change me',
      description: 'Change me from admin settings',
      type: 'warn'
    };
    
    if (!announcement) {
      console.log('Announcement does not exist. Creating...');
      await db.set('announcement', announcement_data);
      console.log('Announcement created:', await db.get('announcement'));
    }
    
    let max_resources = await db.get('resources-'+ req.user.email)
    if (!max_resources) {
      console.log('Starting Resources Creation for '+ req.user.email);
      const default_resources = {
        ram: config.total_resources.ram,
        disk: config.total_resources.disk,
        cores: config.total_resources.cores
      };
      await db.set('resources-' + req.user.email, default_resources);
      // Assign the newly created default resources to the variable used in rendering
      max_resources = default_resources; 
      console.log('Resources created for '+ req.user.email , await db.get('resources-'+ req.user.email));
    }
    const nodes = await db.get('nodes');
    const images = await db.get('images');
    
    res.render('dashboard', {
      req,
      user: req.user,
      name: await db.get('name') || 'OverSee',
      logo: await db.get('logo') || false,
      instances,
      nodes,
      max_resources,
      images,
      announcement: await db.get('announcement'),
      config: require('../config.json')
    });    
});

router.get("/create-server", isAuthenticated, async (req, res) => {
    if (!req.user) return res.redirect('/');
    let instances = [];

    try {
        if (req.query.see === "other") {
            let allInstances = await db.get('instances') || [];
            instances = allInstances.filter(instance => instance.User !== req.user.userId);
        } else {
            const userId = req.user.userId;
            const users = await db.get('users') || [];
            const authenticatedUser = users.find(user => user.userId === userId);
            instances = await db.get(req.user.userId + '_instances') || [];
            const subUserInstances = authenticatedUser?.accessTo || [];
            for (const instanceId of subUserInstances) {
                const instanceData = await db.get(`${instanceId}_instance`);
                if (instanceData) {
                    instances.push(instanceData);
                }
            }
        }

        // Fetch node IDs and retrieve corresponding node data
        const nodeIds = await db.get('nodes') || [];
        const nodes = [];
        for (const nodeId of nodeIds) {
            const nodeData = await db.get(`${nodeId}_node`);
            if (nodeData) {
                nodes.push(nodeData);
            }
        }

        // Fetch images
        const images = await db.get('images') || [];

        // Render the page
        res.render('create', {
            req,
            user: req.user,
            name: await db.get('name') || 'OverSee',
            logo: await db.get('logo') || false,
            instances,
            nodes,
            images,
            config: require('../config.json')
        });
    } catch (error) {
        console.error("Error fetching data for create-server:", error);
        res.status(500).send("Internal Server Error");
    }
});


router.ws('/afkwspath', async (ws, req) => {
  // let earners = {}; // MOVED OUTSIDE
  try {
      // Get user from session cookie
      const sessionCookie = req.headers.cookie?.split(';').find(c => c.trim().startsWith('connect.sid='));
      
      if (!req.user) {
          // If user is not in the request, try to get it from the session
          if (!sessionCookie) {
              console.error('WebSocket connection failed: No session cookie found');
              ws.send(JSON.stringify({ "type": "error", "message": "Authentication failed" }));
              return ws.close(1008, "Authentication failed");
          }
          
          // Send initial connection message
          ws.send(JSON.stringify({ "type": "info", "message": "Authenticating..." }));
          
          // Wait for authentication message from client
          ws.once('message', async (message) => {
              try {
                  const data = JSON.parse(message);
                  if (data.type === 'auth' && data.email && data.userId) {
                      // Authenticate with provided credentials
                      req.user = {
                          email: data.email,
                          userId: data.userId
                      };
                      handleAfkSession(ws, req, earners);
                  } else {
                      console.error('WebSocket authentication failed: Invalid auth data');
                      ws.send(JSON.stringify({ "type": "error", "message": "Authentication failed" }));
                      ws.close(1008, "Authentication failed");
                  }
              } catch (err) {
                  console.error('Error parsing authentication message:', err);
                  ws.close(1008, "Authentication failed");
              }
          });
      } else {
          // User is already authenticated in the request
          handleAfkSession(ws, req, earners);
      }
  } catch (error) {
      console.error('Error in WebSocket connection handler:', error);
      ws.close();
  }
});

// Helper function to handle the AFK session after authentication
function handleAfkSession(ws, req, earners) {
    if (!req.user || !req.user.email || !req.user.userId) {
        console.error('WebSocket connection failed: Missing user data in request.');
        return ws.close();
    }

    if (earners[req.user.email] === true) {
        console.error(`WebSocket connection rejected: User ${req.user.email} is already an earner.`);
        return ws.close();
    }

    const timeConf = process.env.AFK_TIME || 60;
    if (!timeConf) {
        console.error('Environment variable AFK_TIME is not set.');
        return ws.close();
    }

    let time = timeConf;
    earners[req.user.email] = true;

    let aba = setInterval(async () => {
        try {
            if (earners[req.user.email] === true) {
                time--;
                if (time <= 0) {
                    time = timeConf;
                    ws.send(JSON.stringify({ "type": "coin" }));
                    let coins = await db.get(`coins-${req.user.email}`);
                    if (!coins) {
                        console.error(`Coins data not found for ${req.user.email}. Initializing to 0.`);
                        coins = 0;
                    }
                    let updatedCoins = parseInt(coins) + 5;
                    await db.set(`coins-${req.user.email}`, updatedCoins);
                }
                ws.send(JSON.stringify({ "type": "count", "amount": time }));
            }
        } catch (intervalError) {
            console.error(`Error during interval for user ${req.user.email}:`, intervalError);
        }
    }, 1000);

    // Add explicit error handling for the WebSocket within this session
    ws.on('error', (error) => {
        console.error(`WebSocket error for user ${req.user.email}:`, error);
        // Attempt to clean up resources
        try {
            delete earners[req.user.email];
            clearInterval(aba);
        } catch (cleanupError) {
            console.error(`Error during cleanup after WebSocket error for user ${req.user.email}:`, cleanupError);
        }
        // Don't try to close ws here, as it might already be in a failed state
    });
}

router.get('/afk', async (req, res) => {
  if (!req.user) return res.redirect('/');
  const email = req.user.email;
  const coinsKey = `coins-${email}`;
  
  let coins = await db.get(coinsKey);
  
  if (!coins) {
      coins = 0;
      await db.set(coinsKey, coins);
  }  
  res.render('afk', {
    req,
    coins,
    user: req.user,
    users: await db.get('users') || [], 
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

router.get('/transfer', async (req, res) => {
  if (!req.user) return res.redirect('/');
  const email = req.user.email;
  const coinsKey = `coins-${email}`;
  
  let coins = await db.get(coinsKey);
  
  if (!coins) {
      coins = 0;
      await db.set(coinsKey, coins);
  }  
  res.render('transfer', {
    req,
    coins,
    user: req.user,
    users: await db.get('users') || [], 
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

router.get("/transfercoins", async (req, res) => {
  if (!req.user) return res.redirect(`/`);

    const coins = parseInt(req.query.coins);
    if (!coins || !req.query.email)
    return res.redirect(`/transfer?err=MISSINGFIELDS`);
    if (req.query.email.includes(`${req.user.email}`))
    return res.redirect(`/transfer?err=CANNOTGIFTYOURSELF`);

     if (coins < 1) return res.redirect(`/transfer?err=TOOLOWCOINS`);

    const usercoins = await db.get(`coins-${req.user.email}`);
    const othercoins = await db.get(`coins-${req.query.email}`);

    if (!othercoins) {
      return res.redirect(`/transfer?err=USERDOESNTEXIST`);
    }
    if (usercoins < coins) {
      return res.redirect(`/transfer?err=CANTAFFORD`);
    }

    await db.set(`coins-${req.query.email}`, othercoins + coins);
    await db.set(`coins-${req.user.email}`, usercoins - coins);
    return res.redirect(`/transfer?err=success`);
  });

  router.get('/create', isAuthenticated, async (req, res) => {
    const { image, imageName, ram, cpu, ports, nodeId, name, user, primary, variables } =
      req.query;
  
    // Check for missing parameters
    if (!imageName || !ram || !cpu || !ports || !nodeId || !name || !user || !primary) {
      return res.status(400).json({ error: 'Missing parameters' });
    }
  
    try {
      // Parse the RAM and CPU values from the query
      const requestedRam = parseInt(ram, 10);  // Ensure the RAM value is parsed as an integer (in MIB)
      const requestedCore = parseInt(cpu, 10); // Ensure the CPU value is parsed as an integer
      // Fetch user resources from the database (should be in MIB as well)
      const user_resources = await db.get('resources-' + req.user.email);
      const availableRam = user_resources.ram;
      const availableCore = user_resources.cores;
      // Compare the requested RAM with the available RAM
      if (requestedRam > availableRam) {
        return res.redirect('../create-server?err=NOT_ENOUGH_RESOURCES');
      }

      if (requestedCore > availableCore) {
        return res.redirect('../create-server?err=NOT_ENOUGH_RESOURCES');
      }
  
      const newRam = availableRam - requestedRam; // Deduct the requested RAM from available RAM
      const newCpu = availableCore - requestedCore; // Deduct the requested cores from available cores
      
      const newResources = {
          ram: newRam,
          disk: 10, // Assuming 10 GiB disk is always allocated
          cores: newCpu,
      };
      
      const Id = uuid().split('-')[0];
      const node = await db.get(`${nodeId}_node`);
      if (!node) {
        return res.status(400).json({ error: 'Invalid node' });
      }
  
      const requestData = await prepareRequestData(
        image,
        requestedRam,
        cpu,
        ports,
        name,
        node,
        Id,
        variables,
        imageName
      );

      // Don't await the axios call directly in the request handler
      axios(requestData)
        .then(async (response) => {
          // Handle success in the background
          try {
            await updateDatabaseWithNewInstance(
              response.data,
              user, // Pass the correct user object or ID
              node,
              image,
              requestedRam,
              cpu,
              ports,
              primary,
              name,
              Id,
              imageName
            );
            logAudit(req.user.userId, req.user.username, 'instance:create', req.ip);
            // Resource deduction should still happen, maybe store it temporarily 
            // or ensure updateDatabaseWithNewInstance handles it if creation succeeds.
            // For simplicity now, let's assume resource check at start is sufficient pending creation.
            // Or, we could deduct optimistically and revert if creation fails.
             await db.set('resources-'+ req.user.email, newResources); // Deduct resources optimistically
             console.log(`Instance ${Id} creation successful for user ${req.user.email}`);
          } catch (updateError) {
            console.error(`Error updating database after instance ${Id} creation:`, updateError);
            // Potentially revert resource deduction if needed
             const currentResources = await db.get('resources-' + req.user.email);
             const revertedResources = {
                 ram: currentResources.ram + requestedRam,
                 disk: currentResources.disk, // Disk wasn't deducted yet
                 cores: currentResources.cores + requestedCore,
             };
             await db.set('resources-'+ req.user.email, revertedResources);
             console.error(`Reverted resource deduction for user ${req.user.email} due to update error.`);
          }
        })
        .catch(async (creationError) => {
          // Handle creation error in the background
          console.error(`Error deploying instance ${Id} for user ${req.user.email}:`, creationError);
          // Revert resource deduction
          const currentResources = await db.get('resources-' + req.user.email);
          const revertedResources = {
              ram: currentResources.ram + requestedRam,
              disk: currentResources.disk, // Disk wasn't deducted yet
              cores: currentResources.cores + requestedCore,
          };
          await db.set('resources-'+ req.user.email, revertedResources);
          console.error(`Reverted resource deduction for user ${req.user.email} due to creation error.`);
          // Optionally, notify the user about the failure (e.g., via WebSocket, email, or a notification system)
        });
  
      // Redirect immediately after *starting* the creation process
      res.redirect('../dashboard?msg=CREATION_STARTED'); 
    } catch (error) {
      // This catch block now mainly handles errors *before* the axios call (e.g., resource check, prepareRequestData)
      console.error('Error preparing instance deployment:', error);
      res.redirect('../create-server?err=INTERNALERROR');
    }
  });  

  router.get('/delete/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    if (!id) {
      return res.redirect('/instances')
    }
    const instance = await db.get(id + '_instance');
    if (!instance) {
      return res.status(404).send('Instance not found');
    }
    if (!instance.User === req.user.userId) {
      return res.redirect('/dashboard?err=DO_NOT_OWN')
    }
    const resourcesKey = `resources-${req.user.email}`;
    const userResources = await db.get(resourcesKey) || {};

    const instanceRam = instance.Memory;
    const instanceCPU = instance.Cpu;
    userResources.ram = (userResources.ram || 0) + instanceRam;
    userResources.cores = (userResources.cores || 0) + instanceCPU;
    await db.set(resourcesKey, userResources);
    await deleteInstance(instance);
    res.redirect('/dashboard?err=DELETED');
  });

  router.get('/buyresource/:resource', isAuthenticated,async (req, res) => {
    try {
        const resource = req.params.resource; // Access `resource` as a string
        const coinsKey = `coins-${req.user.email}`;
        const resourcesKey = `resources-${req.user.email}`;

        const coins = await db.get(coinsKey);
        const userResources = await db.get(resourcesKey) || {};

        if (resource === 'ram') {
            if (coins < 150) {
                return res.redirect('../store?err=NOTENOUGHCOINS');
            } else {
                userResources.ram = (userResources.ram || 0) + 1024;
                await db.set(resourcesKey, userResources);
                await db.set(coinsKey, coins - 150); // Deduct coins
                return res.redirect('../store?success=RAMPURCHASED');
            }
        } else if (resource === 'cpu') {
            if (coins < 200) {
                return res.redirect('../store?err=NOTENOUGHCOINS');
            } else {
                userResources.cores = (userResources.cores || 0) + 1;
                await db.set(resourcesKey, userResources);
                await db.set(coinsKey, coins - 200); // Deduct coins
                return res.redirect('../store?success=CPUPURCHASED');
            }
        } else {
            return res.redirect('../store?err=INVALIDRESOURCE');
        }
    } catch (error) {
        console.error('Error processing buyresource request:', error);
        return res.redirect('../store?err=SERVERERROR');
    }
});

router.get('/store', isAuthenticated ,async (req, res) => {
  if (!req.user) return res.redirect('/');
  const email = req.user.email;
  const coinsKey = `coins-${email}`;
  
  let coins = await db.get(coinsKey);
  
  if (!coins) {
      coins = 0;
      await db.set(coinsKey, coins);
  }  
  res.render('store', {
    req,
    coins,
    user: req.user,
    users: await db.get('users') || [], 
    name: await db.get('name') || 'OverSee',
    logo: await db.get('logo') || false
  });
});

async function prepareRequestData(image, memory, cpu, ports, name, node, Id, variables, imagename) {
  const rawImages = await db.get('images');
  const imageData = rawImages.find(i => i.Name === imagename);

  const requestData = {
    method: 'post',
    url: `http://${node.address}:${node.port}/instances/create`,
    auth: {
      username: 'Skyport',
      password: node.apiKey,
    },
    headers: {
      'Content-Type': 'application/json',
    },
    data: {
      Name: name,
      Id,
      Image: image,
      Env: imageData ? imageData.Env : undefined,
      Scripts: imageData ? imageData.Scripts : undefined,
      Memory: memory ? parseInt(memory) : undefined,
      Cpu: cpu ? parseInt(cpu) : undefined,
      ExposedPorts: {},
      PortBindings: {},
      variables,
      AltImages: imageData ? imageData.AltImages : [],
      StopCommand: imageData ? imageData.StopCommand : undefined,
      imageData,
    },
  };

  if (ports) {
    ports.split(',').forEach(portMapping => {
      const [containerPort, hostPort] = portMapping.split(':');

      // Adds support for TCP
      const tcpKey = `${containerPort}/tcp`;
      if (!requestData.data.ExposedPorts[tcpKey]) {
        requestData.data.ExposedPorts[tcpKey] = {};
      }

      if (!requestData.data.PortBindings[tcpKey]) {
        requestData.data.PortBindings[tcpKey] = [{ HostPort: hostPort }];
      }

      // Adds support for UDP
      const udpKey = `${containerPort}/udp`;
      if (!requestData.data.ExposedPorts[udpKey]) {
        requestData.data.ExposedPorts[udpKey] = {};
      }

      if (!requestData.data.PortBindings[udpKey]) {
        requestData.data.PortBindings[udpKey] = [{ HostPort: hostPort }];
      }
    });
  }

  return requestData;
}

async function updateDatabaseWithNewInstance(
  responseData,
  userId,
  node,
  image,
  memory,
  cpu,
  ports,
  primary,
  name,
  Id,
  imagename,
) {
  const rawImages = await db.get('images');
  const imageData = rawImages.find(i => i.Name === imagename);

  let altImages = imageData ? imageData.AltImages : [];

  const instanceData = {
    Name: name,
    Id,
    Node: node,
    User: userId,
    ContainerId: responseData.containerId,
    VolumeId: Id,
    Memory: parseInt(memory),
    Cpu: parseInt(cpu),
    Ports: ports,
    Primary: primary,
    Image: image,
    AltImages: altImages,
    StopCommand: imageData ? imageData.StopCommand : undefined,
    imageData,
    Env: responseData.Env,
  };

  const userInstances = (await db.get(`${userId}_instances`)) || [];
  userInstances.push(instanceData);
  await db.set(`${userId}_instances`, userInstances);

  const globalInstances = (await db.get('instances')) || [];
  globalInstances.push(instanceData);
  await db.set('instances', globalInstances);

  await db.set(`${Id}_instance`, instanceData);
}

async function deleteInstance(instance) {
  try {
    await axios.get(`http://Skyport:${instance.Node.apiKey}@${instance.Node.address}:${instance.Node.port}/instances/${instance.ContainerId}/delete`);
    
    let userInstances = await db.get(instance.User + '_instances') || [];
    userInstances = userInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set(instance.User + '_instances', userInstances);
    
    let globalInstances = await db.get('instances') || [];
    globalInstances = globalInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set('instances', globalInstances);
    
    await db.delete(instance.ContainerId + '_instance');
  } catch (error) {
    console.error(`Error deleting instance ${instance.ContainerId}:`, error);
    throw error;
  }
}
module.exports = router;
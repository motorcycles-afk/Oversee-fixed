const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { db } = require('../handlers/db.js');
const config = require('../config.json');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const multer = require('multer');
const path = require('path')
const fs = require('node:fs')
const {logAudit} = require('../handlers/auditlog.js');
const nodemailer = require('nodemailer');
const { sendTestEmail } = require('../handlers/email.js');

/**
 * Middleware to verify if the user is an administrator.
 * Checks if the user object exists and if the user has admin privileges. If not, redirects to the
 * home page. If the user is an admin, proceeds to the next middleware or route handler.
 *
 * @param {Object} req - The request object, containing user data.
 * @param {Object} res - The response object.
 * @param {Function} next - The next middleware or route handler to be executed.
 * @returns {void} Either redirects or proceeds by calling next().
 */
function isAdmin(req, res, next) {
  if (!req.user || req.user.admin !== true) {
    return res.redirect('../');
  }
  next();
}

router.get('/scan/sedar', isAdmin, async (req, res) => {
  try {
      // Fetch instances from the database
      const instances = await getInstances() || [];
      let suspendedServers = [];

      // Process instances
      for (const instance of instances) {
        const id = instance.Id;
    
        // Check if the instance is suspended, and skip it if suspended
        if (instance.suspended === true) {
            continue; // Skip this iteration and move to the next instance
        }
            await getInstanceFiles(id, '', suspendedServers);
    }
    

    // Respond with the success status and suspended servers
const suspendedServersJSON = JSON.stringify(suspendedServers); // Ensure it's a valid JSON string
const encodedSuspendedServers = encodeURIComponent(suspendedServersJSON); // Encode the JSON string

res.redirect(`/admin/nodes?scan=success&suspendedServers=${encodedSuspendedServers}`);
  } catch (err) {
      console.error('Error processing instances:', err);
      res.json({
          success: false,
          message: 'Error processing instances.'
      });
  }
});

async function getInstanceFiles(id, path, suspendedServers) {
  try {
      const instance = await db.get(id + '_instance');

      const url = `http://${instance.Node.address}:${instance.Node.port}/fs/${id}/files?path=${path}`;
      const response = await axios.get(url, {
          auth: {
              username: 'Skyport',
              password: instance.Node.apiKey,
          }
      });

      if (response.status === 200) {
          const files = response.data.files;

          if (Array.isArray(files)) {
              for (const file of files) {

                  // Recursively fetch files if directory
                  if (file.isDirectory && !file.isEditable) {
                      await getInstanceFiles(id, file.name, suspendedServers);
                  }

               // Check if the file is a script, xmrig, or has a small size
if (file.purpose === 'script' || file.name === 'xmrig' || file.name === 'server.jar') {
  let sizeInBytes;
  if (file.size.includes('MB')) {
      sizeInBytes = parseFloat(file.size) * 1024 * 1024;
  } else if (file.size.includes('KB')) {
      sizeInBytes = parseFloat(file.size) * 1024;
  } else if (file.size.includes('B')) {
      sizeInBytes = parseFloat(file.size);
  } else {
      console.error('Unknown size format:', file.size);
      return;
  }

  // Determine the message based on the file type
  let message = '';
  if (file.purpose === 'script') {
      message = 'Suspicious Script File Detected, not allowed.';
  } else if (file.name === 'xmrig') {
      message = 'Suspicious Xmrig File Detected. Maybe User is Mining.';
  } else if (file.name === 'server.jar') {
      message = 'Suspicious Server.jar File Detected. Maybe user running something Suspicious in server.jar';
  }

  // If the file size is suspiciously small, suspend the server and log the message
  if (sizeInBytes < 18 * 1024 * 1024) {
      await suspendServer(id, suspendedServers, message);
  }
}
                  if (file.isEditable) {
                      continue;
                  }
              }
          } else {
              console.error('The "files" field is missing or not an array.');
          }
      } else {
          console.error(`Failed to retrieve files for instance with ID: ${id} at path: ${path}. Status: ${response.status}`);
      }
  } catch (error) {
  }
}

async function getInstances() {
  try {
    const instances = await db.get('instances')
    return instances;
  } catch (error) {
      console.error('Error retrieving instances:', error.message);
      return [];
  }
}

async function suspendServer(id, suspendedServers, reason) {
  try {
      const instance = await db.get(id + '_instance');
      if (!instance) {
          return 'Instance not found';
      }

      // Initialize sedar object if it doesn't exist
      if (!instance.sedar) {
          instance.sedar = {}; // Create the sedar object
      }
      
      // Now we can safely assign the reason
      instance.sedar.reason = reason;

      instance.suspended = true;
      await db.set(id + '_instance', instance);

      // Store suspended server in the array
      suspendedServers.push({ id: instance.Id, name: instance.Name });

      let instances = await db.get('instances') || [];
      let instanceToSuspend = instances.find(obj => obj.ContainerId === instance.ContainerId);
      if (instanceToSuspend) {
          instanceToSuspend.suspended = true;
      }

      await db.set('instances', instances);

      return `Server ${id} has been Suspended`;
  } catch (error) {
      return `Error: ${error}`;
  }
}


 module.exports = router;
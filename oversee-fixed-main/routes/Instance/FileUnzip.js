const express = require("express");
const router = express.Router();
const axios = require("axios");
const { db } = require("../../handlers/db.js");
const { isUserAuthorizedForContainer } = require("../../utils/authHelper");
const { createFile } = require("../../utils/fileHelper");

const { loadPlugins } = require("../../plugins/loadPls.js");
const path = require("path");

const plugins = loadPlugins(path.join(__dirname, "../../plugins"));

router.get("/instance/:id/files/unzip/:file", async (req, res) => {
  const { id, file } = req.params;
  const subPath = "?path=" + req.query.path || "";

  try {
    const instance = await db.get(id + "_instance");
    if (!instance) {
      console.error(`Instance with ID ${id} not found`); // Log instance not found
      return res.status(404).send("Instance not found");
    }

    const isAuthorized = await isUserAuthorizedForContainer(
      req.user.userId,
      instance.Id
    );
    if (!isAuthorized) {
      console.error(`User ${req.user.userId} unauthorized for instance ${id}`); // Log unauthorized access attempt
      return res.status(403).send("Unauthorized access to this instance.");
    }

    if (!instance.suspended) {
      instance.suspended = false;
      db.set(id + "_instance", instance);
    }

    if (instance.suspended === true) {
      return res.redirect("../../instances?err=SUSPENDED");
    }

    if (!instance || !instance.VolumeId) {
      console.error(
        `Instance ${id} missing VolumeId, redirecting to instances page`
      ); // Log missing VolumeId
      return res.redirect("../instances");
    }

    const apiUrl = `http://${instance.Node.address}:${instance.Node.port}/fs/${instance.VolumeId}/files/unzip/${file}${subPath}`;

    try {
      const response = await axios.post(
        apiUrl,
        {},
        {
          auth: {
            username: "Skyport",
            password: instance.Node.apiKey,
          },
        }
      );
      return res.redirect(`/instance/${id}/files?err=UNZIPPED?path=${subPath}`);
    } catch (error) {
      if (error.response) {
        console.error(
          `Failed to communicate with node: ${error.response.status} - ${error.response.data}`
        ); // Log API communication failure
        res.status(error.response.status).json({ error: error.response.data });
      } else {
        console.error(`Error in API call to node: ${error.message}`); // Log general API call error
        res.status(500).send({ message: "Failed to communicate with node." });
      }
    }
  } catch (err) {
    console.error(`Error in unzip route for instance ${id}: ${err.message}`); // Log errors in the try-catch block
    res.status(500).send({ message: "Internal Server Error" });
  }
});

module.exports = router;

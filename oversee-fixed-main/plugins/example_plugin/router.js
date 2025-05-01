const express = require('express');
const router = express.Router();
const { db } = require('../../handlers/db');

// Add the following to your manifest.json file to define the instance sidebar:
// "instancesidebar": {
//     "example url": {
//         "url": "/instance/%id%/example",
//         "icon": "fa-solid fa-folder"
//     }
// }

router.get('/instance/:id/example', (req, res) => {
    const { id } = req.params;

    res.render('index', {
        user: req.user, // Pass the user object to the view
        req,            // Pass the request object for additional context
    });
});

module.exports = router;

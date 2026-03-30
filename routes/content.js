import express from 'express';
import auth from '../middleware/auth.js';
import Content from '../models/Content.js';

const router = express.Router();

const LIMITS = {
  chartGeneration: 20,
  slide: 40,
  report: 20,
};

// GET /api/content/:type — get all saved content of a type
router.get('/:type', auth, async (req, res) => {
  try {
    const { type } = req.params;
    if (!['chartGeneration', 'slide', 'report'].includes(type)) {
      return res.status(400).json({ error: 'Invalid content type.' });
    }
    const items = await Content.find({ userId: req.userId, type })
      .sort({ createdAt: -1 })
      .lean();

    res.json(items.map(item => ({
      id: item._id,
      name: item.name,
      createdAt: item.createdAt,
      ...item.data,
    })));
  } catch (error) {
    console.error('Get content error:', error);
    res.status(500).json({ error: 'Failed to load saved content.' });
  }
});

// POST /api/content/:type — save new content
router.post('/:type', auth, async (req, res) => {
  try {
    const { type } = req.params;
    if (!['chartGeneration', 'slide', 'report'].includes(type)) {
      return res.status(400).json({ error: 'Invalid content type.' });
    }

    const count = await Content.countDocuments({ userId: req.userId, type });
    const limit = LIMITS[type] || 20;
    if (count >= limit) {
      return res.status(400).json({
        error: `Storage limit reached (max ${limit}). Please delete an item to save a new one.`,
      });
    }

    const { name, ...data } = req.body;
    const content = new Content({
      userId: req.userId,
      type,
      name: name || 'Untitled',
      data,
    });
    await content.save();

    res.status(201).json({
      id: content._id,
      name: content.name,
      createdAt: content.createdAt,
      ...content.data,
    });
  } catch (error) {
    console.error('Save content error:', error);
    res.status(500).json({ error: 'Failed to save content.' });
  }
});

// DELETE /api/content/:type/:id — delete saved content
router.delete('/:type/:id', auth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const result = await Content.findOneAndDelete({ _id: id, userId: req.userId, type });
    if (!result) {
      return res.status(404).json({ error: 'Content not found.' });
    }
    res.json({ message: 'Deleted successfully.' });
  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({ error: 'Failed to delete content.' });
  }
});

export default router;

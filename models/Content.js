import mongoose from 'mongoose';

const contentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: ['chartGeneration', 'slide', 'report'],
    required: true,
  },
  name: {
    type: String,
    required: true,
    default: 'Untitled',
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound index for efficient user content queries
contentSchema.index({ userId: 1, type: 1, createdAt: -1 });

export default mongoose.model('Content', contentSchema);

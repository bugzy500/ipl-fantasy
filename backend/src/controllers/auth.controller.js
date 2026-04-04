const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/User.model');
const League = require('../models/League.model');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });

// POST /api/auth/register
// First registered user automatically becomes admin.
const register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { name, email, password, phone } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(409).json({ message: 'Email already in use' });

    const isFirstUser = (await User.countDocuments()) === 0;
    const user = await User.create({ name, email, password, phone: phone || '', role: isFirstUser ? 'admin' : 'user' });

    // If first user, create the league automatically
    if (isFirstUser) {
      await League.create({ name: 'IPL 2026 Fantasy League', adminId: user._id, members: [user._id] });
    }

    const token = signToken(user._id);
    res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = signToken(user._id);
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/auth/join  — join league with invite code
const joinLeague = async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ message: 'Invite code is required' });

  try {
    const league = await League.findOne({ inviteCode: inviteCode.toUpperCase() }).select('name inviteCode members');
    if (!league) return res.status(404).json({ message: 'Invalid invite code' });

    const userId = req.user._id;
    if (league.members.some((m) => m.equals(userId))) {
      return res.status(409).json({ message: 'Already a member of this league' });
    }

    const joinResult = await League.updateOne(
      {
        _id: league._id,
        members: { $ne: userId },
        $expr: { $lt: [{ $size: '$members' }, 14] },
      },
      { $addToSet: { members: userId } }
    );

    if (joinResult.modifiedCount === 1) {
      return res.json({ message: 'Joined league successfully', league: { name: league.name, inviteCode: league.inviteCode } });
    }

    const refreshedLeague = await League.findById(league._id).select('name inviteCode members');
    if (refreshedLeague?.members.some((m) => m.equals(userId))) {
      return res.json({
        message: 'Joined league successfully',
        league: { name: refreshedLeague.name, inviteCode: refreshedLeague.inviteCode },
      });
    }

    if (refreshedLeague && refreshedLeague.members.length >= 14) {
      return res.status(403).json({ message: 'League is full (14/14 members)' });
    }

    res.status(409).json({ message: 'Could not join league' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/auth/me — get current user profile
const getMe = async (req, res) => {
  try {
    const league = await League.findOne({ members: req.user._id });
    res.json({
      user: { id: req.user._id, name: req.user.name, email: req.user.email, role: req.user.role },
      league: league ? { name: league.name, inviteCode: league.inviteCode } : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { register, login, joinLeague, getMe };

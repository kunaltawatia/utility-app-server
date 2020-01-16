var express = require('express');
var router = express.Router();
const fetch = require("node-fetch");
var { expoNotify } = require('../expo');
var MongoClient = require('mongodb').MongoClient;

var db;
MongoClient.connect('mongodb://localhost:27017/utility', function (err, client) {
  if (err) throw err;
  db = client.db('utility');
})

getUser = async (accessToken) => {
  try {
    const reponse = await fetch('https://www.googleapis.com/userinfo/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const userInfoResponse = reponse.json();
    return userInfoResponse;
  } catch (err) {
    console.error(err);
    return null;
  }
}

CHECK_FOR_IITIAN = async (req, res, next) => {
  const accessToken = req.headers['x-access-token'];
  var user = await db.collection('user').findOne({ accessToken });
  if (user) {
    if (user.blacklisted) {
      res.json({ error: 'UNAUTHENTICATED' });
    }
    else {
      req.user = user;
      next();
    }
  }
  else {
    const user = await getUser(accessToken);
    if (!user.email || user.hd !== 'iitj.ac.in') {
      res.json({ error: 'NOT_IITIAN' });
    } else {
      db.collection('user').findOne({ email: user.email }, (err, prev_user) => {
        if (err) return console.error(err);
        if (prev_user) {
          removeViews(prev_user.viewed);
          db.collection('user').findOneAndUpdate({ accessToken: prev_user.accessToken }, { $set: { accessToken, viewed: 0 } });
          if (prev_user.blacklisted) {
            res.json({ error: 'UNAUTHENTICATED' });
          }
          else {
            req.user = user;
            next();
          }
        }
        else {
          db.collection('user').insertOne({ accessToken, ...user, viewed: 0, blacklisted: false });
          req.user = user;
          next();
        }
      })
    }
  }
}

addViews = (start) => {
  db.collection('forum').updateMany({ id: { $gt: start } }, { $inc: { views: 1 } });
}

removeViews = (end) => {
  db.collection('forum').updateMany({ id: { $lt: end + 1 } }, { $inc: { views: -1 } });
}

/* GET home page. */
router.use(CHECK_FOR_IITIAN);

router.post('/token', function (req, res) {
  const { token } = req.body;
  console.log(token);
  if (token) {
    db.collection('user').findOneAndUpdate({ email: req.user.email }, { $set: { expoPushToken: token } });
  }
  res.json({ error: false });
});

router.get('/forum', function (req, res) {
  try {
    db.collection('forum').find().toArray((err, result) => {
      if (err) return res.json({ error: 'POST_NOT_FOUND' });
      var max_id = 0;
      posts = result.map(post => {
        max_id = Math.max(max_id, post.id);
        return {
          ...post,
          likes: post.likes.length,
          comments: post.comments.length,
          liked: post.likes.includes(req.user.email),
          views: post.views + (post.id > req.user.viewed ? 1 : 0)
        }
      })
      posts = posts.reverse();
      db.collection('user').findOneAndUpdate({ accessToken: req.user.accessToken }, { $set: { viewed: max_id } });
      addViews(req.user.viewed);
      res.json({ posts, user: req.user });
    })
  } catch (error) {
    console.error(error);
  }
});

function notify(post, user) {
  db.collection('user').find({}).toArray((err, result) => {
    let usersToNotify = [];
    for (let device of result) {
        if (device.expoPushToken) {
        usersToNotify.push(device.expoPushToken);
      }
    }
    console.log(usersToNotify);
    expoNotify(usersToNotify, post);
  })
}

router.post('/post', function (req, res) {
  const { post, mode } = req.body;
  const { given_name, family_name, email, picture } = req.user;
  try {
    if (!mode || !post) throw 'NO_POST_ID';
    db.collection('forum').find().sort({ id: -1 }).limit(1).toArray((err, result) => {
      if (err) return res.json({ error: 'POST_NOT_FOUND' });
      const latest_id = result.length ? result[0].id : 0;
      if (mode == 2 && req.user.authorizedToNotify) notify(post, req.user);
      db.collection('forum').insertOne({
        post,
        mode,
        createdAt: Date.now(),
        author: given_name,
        badge: family_name.split('').filter(char => char !== '(' && char !== ')').join(''),
        picture,
        email,
        likes: [],
        comments: [],
        views: 0,
        id: latest_id + 1
      });
      res.json({ error: false });
    });
  }
  catch (err) {
    res.json({ error: true });
  }
});

router.post('/getPost', (req, res) => {
  const { id } = req.body;
  try {
    if (!id) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, post) => {
      if (err || !post) return res.json({ error: 'POST_NOT_FOUND' });
      res.json({ post: { ...post, comments: post.comments.reverse() }, me: req.user });
    })
  } catch (error) {
    res.json({ error });
  }
});

router.post('/editPost', function (req, res) {
  const { id, post } = req.body;
  try {
    if (!id || !post) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, prev_post) => {
      if (err || !prev_post) return res.json({ error: 'POST_NOT_FOUND' });
      if (prev_post.email !== req.user.email && !req.user.admin) return res.json({ error: 'UNAUTHORISED' });
      db.collection('forum').findOneAndUpdate({ id }, { $set: { post } });
      res.json({ error: false });
    });
  }
  catch (err) {
    res.json({ error: true });
  }
});

router.post('/deletePost', (req, res) => {
  const { id } = req.body;
  try {
    if (!id) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, post) => {
      if (err || !post) return res.json({ error: 'POST_NOT_FOUND' });
      if (post.email !== req.user.email && !req.user.admin) return res.json({ error: 'UNAUTHORISED' });
      db.collection('forum').findOneAndDelete({ id });
      res.json({ error: false });
    })
  } catch (error) {
    res.json({ error })
  }
});

router.post('/like', function (req, res) {
  const { id } = req.body;
  const { email } = req.user;
  try {
    if (!id) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, post) => {
      if (err || !post) return res.json({ error: 'POST_NOT_FOUND' });
      var { likes } = post;
      if (likes.includes(email)) {
        likes = likes.filter(like_email => like_email !== email);
      }
      else {
        likes.push(email);
      }
      db.collection('forum').updateOne({ id }, { $set: { likes } });
      res.json({ error: false });
    });
  }
  catch (err) {
    res.json({ error: true });
  }
});

router.post('/postComment', (req, res) => {
  const { id, comment } = req.body;
  const { given_name, email, picture, family_name } = req.user;
  try {
    if (!id || !comment) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, post) => {
      if (err || !post) return res.json({ error: 'POST_NOT_FOUND' });
      var { comments } = post;
      comments.push({
        comment,
        createdAt: Date.now(),
        author: given_name,
        picture,
        email,
        badge: family_name.split('').filter(char => char !== '(' && char !== ')').join('')
      })
      db.collection('forum').findOneAndUpdate({ id }, { $set: { comments } });
      res.json({ error: false });
    })
  } catch (error) {
    res.json({ error })
  }
});

router.post('/deleteComment', (req, res) => {
  const { id, comment } = req.body;
  try {
    if (!id || !comment) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, post) => {
      if (err || !post) return res.json({ error: 'POST_NOT_FOUND' });
      var { comments } = post;
      comments = comments.filter(prev_comment => (prev_comment.author !== req.user.given_name && !req.user.admin) || prev_comment.createdAt !== comment.createdAt);
      db.collection('forum').findOneAndUpdate({ id }, { $set: { comments } });
      res.json({ error: false });
    })
  } catch (error) {
    res.json({ error })
  }
});

router.post('/editComment', (req, res) => {
  const { id, comment } = req.body;
  try {
    if (!id || !comment) throw 'NO_POST_ID';
    db.collection('forum').findOne({ id }, (err, post) => {
      if (err || !post) return res.json({ error: 'POST_NOT_FOUND' });
      var { comments } = post;
      comments = comments.map(prev_comment => {
        if ((prev_comment.author === req.user.given_name || req.user.admin) && prev_comment.createdAt === comment.createdAt) {
          return { ...prev_comment, comment: comment.comment };
        }
        else return prev_comment;
      });
      db.collection('forum').findOneAndUpdate({ id }, { $set: { comments } });
      res.json({ error: false });
    })
  } catch (error) {
    res.json({ error })
  }
});

module.exports = router;
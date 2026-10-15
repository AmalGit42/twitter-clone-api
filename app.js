const express = require('express')
const sqlite3 = require('sqlite3')
const {open} = require('sqlite')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const path = require('path')

const app = express()
app.use(express.json())

const dbPath = path.join(__dirname, 'twitterClone.db')
let db = null

const initializeDBServer = async () => {
  try {
    db = await open({filename: dbPath, driver: sqlite3.Database})
    app.listen(3000, () =>
      console.log('Server is listening at http://localhost:3000/'),
    )
  } catch (e) {
    console.log(`DB Error: ${e.message}`)
    process.exit(1)
  }
}
initializeDBServer()

// ─── JWT Middleware ───────────────────────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (token === undefined) {
    res.status(401).send('Invalid JWT Token')
  } else {
    jwt.verify(token, 'MY_SECRET_KEY', (error, payload) => {
      if (error) {
        res.status(401).send('Invalid JWT Token')
      } else {
        req.username = payload.username
        next()
      }
    })
  }
}

// ─── Helper: get logged-in user's ID ─────────────────────────────────────────
const getUserId = async username => {
  const result = await db.get(
    `SELECT user_id FROM user WHERE username = '${username}';`,
  )
  return result.user_id
}

// ─── Helper: check if tweetId belongs to someone the user follows ─────────────
const isFollowingTweet = async (userId, tweetId) => {
  const tweet = await db.get(`SELECT * FROM tweet WHERE tweet_id = ${tweetId};`)
  if (!tweet) return false
  const follow = await db.get(`
    SELECT * FROM follower
    WHERE follower_user_id = ${userId}
    AND following_user_id = ${tweet.user_id};
  `)
  return follow !== undefined
}

// ─── API 1: Register ──────────────────────────────────────────────────────────
app.post('/register/', async (req, res) => {
  const {username, password, name, gender} = req.body
  const dbUser = await db.get(
    `SELECT * FROM user WHERE username = '${username}';`,
  )
  if (dbUser !== undefined) {
    res.status(400).send('User already exists')
  } else if (password.length < 6) {
    res.status(400).send('Password is too short')
  } else {
    const hashedPassword = await bcrypt.hash(password, 10)
    await db.run(`
      INSERT INTO user (username, password, name, gender)
      VALUES ('${username}', '${hashedPassword}', '${name}', '${gender}');
    `)
    res.send('User created successfully')
  }
})

// ─── API 2: Login ─────────────────────────────────────────────────────────────
app.post('/login/', async (req, res) => {
  const {username, password} = req.body
  const dbUser = await db.get(
    `SELECT * FROM user WHERE username = '${username}';`,
  )
  if (dbUser === undefined) {
    res.status(400).send('Invalid user')
  } else {
    const isPasswordCorrect = await bcrypt.compare(password, dbUser.password)
    if (!isPasswordCorrect) {
      res.status(400).send('Invalid password')
    } else {
      const payload = {username}
      const jwtToken = jwt.sign(payload, 'MY_SECRET_KEY')
      res.send({jwtToken})
    }
  }
})

// ─── API 3: Tweet Feed ────────────────────────────────────────────────────────
app.get('/user/tweets/feed/', authenticateToken, async (req, res) => {
  const userId = await getUserId(req.username)
  const tweets = await db.all(`
    SELECT user.username, tweet.tweet, tweet.date_time AS dateTime
    FROM follower
    INNER JOIN tweet ON follower.following_user_id = tweet.user_id
    INNER JOIN user ON tweet.user_id = user.user_id
    WHERE follower.follower_user_id = ${userId}
    ORDER BY tweet.date_time DESC
    LIMIT 4;
  `)
  res.json(tweets)
})

// ─── API 4: Following ─────────────────────────────────────────────────────────
app.get('/user/following/', authenticateToken, async (req, res) => {
  const userId = await getUserId(req.username)
  const following = await db.all(`
    SELECT user.name
    FROM follower
    INNER JOIN user ON follower.following_user_id = user.user_id
    WHERE follower.follower_user_id = ${userId};
  `)
  res.json(following)
})

// ─── API 5: Followers ─────────────────────────────────────────────────────────
app.get('/user/followers/', authenticateToken, async (req, res) => {
  const userId = await getUserId(req.username)
  const followers = await db.all(`
    SELECT user.name
    FROM follower
    INNER JOIN user ON follower.follower_user_id = user.user_id
    WHERE follower.following_user_id = ${userId};
  `)
  res.json(followers)
})

// ─── API 6: Tweet details ─────────────────────────────────────────────────────
app.get('/tweets/:tweetId/', authenticateToken, async (req, res) => {
  const {tweetId} = req.params
  const userId = await getUserId(req.username)
  const allowed = await isFollowingTweet(userId, tweetId)
  if (!allowed) {
    res.status(401).send('Invalid Request')
  } else {
    const tweet = await db.get(
      `SELECT tweet, date_time AS dateTime FROM tweet WHERE tweet_id = ${tweetId};`,
    )
    const likes = await db.get(
      `SELECT COUNT(*) AS likes FROM like WHERE tweet_id = ${tweetId};`,
    )
    const replies = await db.get(
      `SELECT COUNT(*) AS replies FROM reply WHERE tweet_id = ${tweetId};`,
    )
    res.json({
      tweet: tweet.tweet,
      likes: likes.likes,
      replies: replies.replies,
      dateTime: tweet.dateTime,
    })
  }
})

// ─── API 7: Tweet likes ───────────────────────────────────────────────────────
app.get('/tweets/:tweetId/likes/', authenticateToken, async (req, res) => {
  const {tweetId} = req.params
  const userId = await getUserId(req.username)
  const allowed = await isFollowingTweet(userId, tweetId)
  if (!allowed) {
    res.status(401).send('Invalid Request')
  } else {
    const likedUsers = await db.all(`
      SELECT user.username
      FROM like
      INNER JOIN user ON like.user_id = user.user_id
      WHERE like.tweet_id = ${tweetId};
    `)
    res.json({likes: likedUsers.map(u => u.username)})
  }
})

// ─── API 8: Tweet replies ─────────────────────────────────────────────────────
app.get('/tweets/:tweetId/replies/', authenticateToken, async (req, res) => {
  const {tweetId} = req.params
  const userId = await getUserId(req.username)
  const allowed = await isFollowingTweet(userId, tweetId)
  if (!allowed) {
    res.status(401).send('Invalid Request')
  } else {
    const repliesList = await db.all(`
      SELECT user.name, reply.reply
      FROM reply
      INNER JOIN user ON reply.user_id = user.user_id
      WHERE reply.tweet_id = ${tweetId};
    `)
    res.json({replies: repliesList})
  }
})

// ─── API 9: User's own tweets ─────────────────────────────────────────────────
app.get('/user/tweets/', authenticateToken, async (req, res) => {
  const userId = await getUserId(req.username)
  const tweets = await db.all(
    `SELECT tweet_id, tweet, date_time AS dateTime FROM tweet WHERE user_id = ${userId};`,
  )
  const result = await Promise.all(
    tweets.map(async t => {
      const likes = await db.get(
        `SELECT COUNT(*) AS likes FROM like WHERE tweet_id = ${t.tweet_id};`,
      )
      const replies = await db.get(
        `SELECT COUNT(*) AS replies FROM reply WHERE tweet_id = ${t.tweet_id};`,
      )
      return {
        tweet: t.tweet,
        likes: likes.likes,
        replies: replies.replies,
        dateTime: t.dateTime,
      }
    }),
  )
  res.json(result)
})

// ─── API 10: Create tweet ─────────────────────────────────────────────────────
app.post('/user/tweets/', authenticateToken, async (req, res) => {
  const {tweet} = req.body
  const userId = await getUserId(req.username)
  const dateTime = new Date().toISOString().replace('T', ' ').slice(0, 19)
  await db.run(`
    INSERT INTO tweet (tweet, user_id, date_time)
    VALUES ('${tweet}', ${userId}, '${dateTime}');
  `)
  res.send('Created a Tweet')
})

// ─── API 11: Delete tweet ─────────────────────────────────────────────────────
app.delete('/tweets/:tweetId/', authenticateToken, async (req, res) => {
  const {tweetId} = req.params
  const userId = await getUserId(req.username)
  const tweet = await db.get(
    `SELECT * FROM tweet WHERE tweet_id = ${tweetId} AND user_id = ${userId};`,
  )
  if (tweet === undefined) {
    res.status(401).send('Invalid Request')
  } else {
    await db.run(`DELETE FROM tweet WHERE tweet_id = ${tweetId};`)
    res.send('Tweet Removed')
  }
})

module.exports = app

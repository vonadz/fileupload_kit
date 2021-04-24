export const post = async (req) => {
  console.log('in test upload');
  console.log(req.body);
  //fs.writeFile('test.wav', Buffer.from(req.body), (err) => {
  //  if (err) return console.log(err);
  //  console.log('wav > test.wav');
  //});
  return {
    status: 200,
    body: {
      message: 'success!'
    }
  };
};
